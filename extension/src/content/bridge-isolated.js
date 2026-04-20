/**
 * content/bridge-isolated.js — ISOLATED-world content script.
 *
 * Receives RPC messages from the service worker via chrome.runtime.onMessage
 * and executes DOM-level operations in the page. This is the DOM half of the
 * tool surface defined in src/tools/dom.js and src/tools/storage.js.
 *
 * Design goals:
 *   - Zero dependency on page globals.
 *   - Robust element resolution: selector, text, role+name, and ref-ids.
 *   - Semantic snapshots: ARIA-role tree with stable refs, filtered for noise.
 *   - Every handler returns JSON-serializable data.
 */

;(() => {
  if (window.__opensin_isolated__) return
  window.__opensin_isolated__ = true

  // ---- Ref registry. Each snapshot assigns incrementing "ref-ids" to nodes;
  // tool calls can then pass { ref: "e12" } instead of a selector. The
  // registry stores WeakRefs so GC'd nodes are cleaned lazily.
  const refs = new Map()
  let refSeq = 0
  function mintRef(el) {
    const id = `e${++refSeq}`
    refs.set(id, new WeakRef(el))
    return id
  }
  function resolveRef(id) {
    const wr = refs.get(id)
    if (!wr) return null
    const el = wr.deref()
    if (!el || !el.isConnected) {
      refs.delete(id)
      return null
    }
    return el
  }

  // ---- Element resolution ---------------------------------------------------
  function resolve({ selector, ref }) {
    if (ref) {
      const el = resolveRef(ref)
      if (!el) throw err("Element reference not found or detached", "NOT_FOUND")
      return el
    }
    if (!selector) throw err("selector or ref required", "INVALID_ARGS")
    // Extended selector syntax:
    //   "text=Login"        -> first element whose trimmed text equals "Login"
    //   "aria/Button:Save"  -> role=Button with accessible name "Save"
    //   "xpath=//..."       -> XPath
    //   CSS otherwise.
    if (selector.startsWith("text=")) {
      const needle = selector.slice(5)
      return findByText(needle)
    }
    if (selector.startsWith("aria/")) {
      const [role, name] = selector.slice(5).split(":")
      return findByRole(role, name)
    }
    if (selector.startsWith("xpath=")) {
      const xp = selector.slice(6)
      const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
      return r.singleNodeValue
    }
    return document.querySelector(selector)
  }

  function findByText(text) {
    const needle = text.trim().toLowerCase()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    let n
    while ((n = walker.nextNode())) {
      if (!isVisible(n)) continue
      const t = (n.innerText || n.textContent || "").trim().toLowerCase()
      if (t === needle) return n
    }
    // Fallback: contains
    const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    while ((n = walker2.nextNode())) {
      if (!isVisible(n)) continue
      const t = (n.innerText || n.textContent || "").trim().toLowerCase()
      if (t.includes(needle)) return n
    }
    return null
  }

  function findByRole(role, name) {
    const nameLc = name?.trim().toLowerCase()
    const candidates = document.querySelectorAll(`[role="${role}"], ${roleToTags(role)}`)
    for (const el of candidates) {
      if (!isVisible(el)) continue
      const acc = accessibleName(el)
      if (!nameLc || acc.toLowerCase() === nameLc || acc.toLowerCase().includes(nameLc)) return el
    }
    return null
  }

  function roleToTags(role) {
    const map = {
      button: "button,input[type=button],input[type=submit]",
      link: "a[href]",
      textbox: "input:not([type=button]):not([type=submit]),textarea,[contenteditable='true']",
      checkbox: "input[type=checkbox]",
      radio: "input[type=radio]",
      combobox: "select,[role=combobox]",
      heading: "h1,h2,h3,h4,h5,h6",
    }
    return map[role?.toLowerCase()] || "*"
  }

  function accessibleName(el) {
    if (!el) return ""
    const labelledby = el.getAttribute("aria-labelledby")
    if (labelledby) {
      const ids = labelledby.split(/\s+/)
      const parts = ids.map((id) => document.getElementById(id)?.innerText?.trim() || "").filter(Boolean)
      if (parts.length) return parts.join(" ")
    }
    const ariaLabel = el.getAttribute("aria-label")
    if (ariaLabel) return ariaLabel.trim()
    const title = el.getAttribute("title")
    if (title) return title.trim()
    const alt = el.getAttribute("alt")
    if (alt) return alt.trim()
    const placeholder = el.getAttribute("placeholder")
    if (placeholder) return placeholder.trim()
    if (el.tagName === "INPUT" && el.labels?.length) return el.labels[0].innerText.trim()
    const text = (el.innerText || el.textContent || "").trim()
    return text.slice(0, 120)
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false
    if (el.nodeType !== 1) return false
    const rect = el.getBoundingClientRect?.()
    if (!rect) return false
    if (rect.width === 0 && rect.height === 0) return false
    const style = getComputedStyle(el)
    if (style.visibility === "hidden" || style.display === "none") return false
    if (parseFloat(style.opacity) === 0) return false
    return true
  }

  function stableSelector(el) {
    if (!el || el.nodeType !== 1) return ""
    if (el.id) return `#${cssEscape(el.id)}`
    // data-testid / data-test
    for (const attr of ["data-testid", "data-test", "data-qa"]) {
      const v = el.getAttribute(attr)
      if (v) return `[${attr}="${attr === "data-test" ? v : cssEscapeAttr(v)}"]`
    }
    // Prefer role+name selector when distinctive.
    const role = el.getAttribute("role") || implicitRole(el)
    const name = accessibleName(el).slice(0, 60)
    if (role && name) return `aria/${role}:${name}`
    // Build CSS path (cap depth).
    const parts = []
    let node = el
    for (let i = 0; i < 6 && node && node.nodeType === 1; i++) {
      let part = node.tagName.toLowerCase()
      if (node.classList?.length) {
        const cls = [...node.classList].filter((c) => /^[a-zA-Z][\w-]{0,40}$/.test(c)).slice(0, 2)
        if (cls.length) part += "." + cls.join(".")
      }
      const parent = node.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((n) => n.tagName === node.tagName)
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
      }
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(" > ")
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase()
    if (tag === "a" && el.hasAttribute("href")) return "link"
    if (tag === "button") return "button"
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase()
      if (t === "button" || t === "submit" || t === "reset") return "button"
      if (t === "checkbox") return "checkbox"
      if (t === "radio") return "radio"
      return "textbox"
    }
    if (tag === "textarea") return "textbox"
    if (tag === "select") return "combobox"
    if (/^h[1-6]$/.test(tag)) return "heading"
    if (tag === "img") return "img"
    if (tag === "nav") return "navigation"
    if (tag === "main") return "main"
    return null
  }

  function cssEscape(v) {
    return window.CSS?.escape ? CSS.escape(v) : v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
  }
  function cssEscapeAttr(v) {
    return v.replace(/"/g, '\\"')
  }

  // ---- Semantic snapshot ----------------------------------------------------
  function buildSnapshot({ mode = "semantic", maxNodes = 2000, includeHidden = false } = {}) {
    refs.clear()
    refSeq = 0
    const out = {
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight, scrollX: scrollX, scrollY: scrollY },
      capturedAt: Date.now(),
      nodes: [],
    }
    let count = 0

    function visit(el, depth) {
      if (count >= maxNodes || !el || el.nodeType !== 1) return null
      if (!includeHidden && !isVisible(el) && !el.matches?.("html,body")) return null

      const role = el.getAttribute("role") || implicitRole(el)
      const isInteractive = /^(button|link|textbox|checkbox|radio|combobox|option|tab|menuitem)$/.test(role || "")
      const isLandmark = /^(navigation|main|banner|contentinfo|complementary|region|form|search)$/.test(role || "")
      const includeNode = mode === "full" || isInteractive || isLandmark || /^h[1-6]$/.test(el.tagName.toLowerCase())

      let node = null
      if (includeNode) {
        const ref = mintRef(el)
        const rect = el.getBoundingClientRect()
        node = {
          ref,
          role,
          tag: el.tagName.toLowerCase(),
          name: accessibleName(el).slice(0, 160),
          selector: stableSelector(el),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          value: el.value !== undefined ? String(el.value).slice(0, 200) : undefined,
          checked: el.checked,
          disabled: el.disabled,
          readOnly: el.readOnly,
          href: el.getAttribute?.("href"),
          type: el.getAttribute?.("type"),
          placeholder: el.getAttribute?.("placeholder"),
          children: [],
        }
        count += 1
        out.nodes.push(node)
      }
      for (const child of el.children) {
        const c = visit(child, depth + 1)
        if (node && c) node.children.push(c)
      }
      return node
    }
    visit(document.documentElement, 0)
    return out
  }

  // ---- Input synthesis ------------------------------------------------------
  // Track the last synthetic pointer position so consecutive actions share a
  // plausible mouse trajectory instead of teleporting across the viewport.
  let __lastPointer = { x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2) }

  function gaussian(mean, stddev) {
    // Box-Muller. Clamped so we never return negative delays.
    const u1 = 1 - Math.random()
    const u2 = 1 - Math.random()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    return Math.max(0, mean + stddev * z)
  }

  // Quadratic Bezier with a single random control point offset perpendicular
  // to the start->end vector. Produces a curved, non-linear trajectory that
  // does not look like a straight-line snap.
  function* bezierPath(x0, y0, x1, y1, steps) {
    const dx = x1 - x0
    const dy = y1 - y0
    const dist = Math.hypot(dx, dy) || 1
    const nx = -dy / dist
    const ny = dx / dist
    const jitter = Math.min(dist * 0.25, 140) * (Math.random() - 0.5) * 2
    const cx = (x0 + x1) / 2 + nx * jitter
    const cy = (y0 + y1) / 2 + ny * jitter
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const it = 1 - t
      yield {
        x: it * it * x0 + 2 * it * t * cx + t * t * x1,
        y: it * it * y0 + 2 * it * t * cy + t * t * y1,
      }
    }
  }

  async function moveMouse(fromX, fromY, toX, toY, { human = true } = {}) {
    const dist = Math.hypot(toX - fromX, toY - fromY)
    const steps = Math.max(6, Math.min(32, Math.round(dist / 28)))
    if (!human) {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: toX, clientY: toY, bubbles: true }))
      __lastPointer = { x: toX, y: toY }
      return
    }
    for (const pt of bezierPath(fromX, fromY, toX, toY, steps)) {
      const ev = {
        clientX: pt.x,
        clientY: pt.y,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      }
      const target = document.elementFromPoint(pt.x, pt.y) || document.documentElement
      target.dispatchEvent(new PointerEvent("pointermove", { ...ev, pointerType: "mouse" }))
      target.dispatchEvent(new MouseEvent("mousemove", ev))
      await sleep(gaussian(12, 5))
    }
    __lastPointer = { x: toX, y: toY }
  }

  async function humanClick(el, opts = {}) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
    await sleep(gaussian(80, 30))
    const rect = el.getBoundingClientRect()
    // Pick a point slightly off-centre inside the target -- real users do not
    // hit geometric centres.
    const pad = 6
    const minX = rect.left + Math.min(pad, rect.width / 4)
    const maxX = rect.right - Math.min(pad, rect.width / 4)
    const minY = rect.top + Math.min(pad, rect.height / 4)
    const maxY = rect.bottom - Math.min(pad, rect.height / 4)
    const x = minX + Math.random() * Math.max(1, maxX - minX)
    const y = minY + Math.random() * Math.max(1, maxY - minY)

    if (opts.human !== false) {
      await moveMouse(__lastPointer.x, __lastPointer.y, x, y, { human: true })
    } else {
      __lastPointer = { x, y }
    }

    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: opts.button === "right" ? 2 : opts.button === "middle" ? 1 : 0,
      buttons: 1,
      view: window,
    }
    el.dispatchEvent(new PointerEvent("pointerover", { ...init, pointerType: "mouse" }))
    el.dispatchEvent(new MouseEvent("mouseover", init))
    await sleep(gaussian(40, 15))
    el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse", isPrimary: true }))
    el.dispatchEvent(new MouseEvent("mousedown", init))
    if (opts.human !== false) await sleep(gaussian(70, 25))
    el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse" }))
    el.dispatchEvent(new MouseEvent("mouseup", init))
    for (let i = 0; i < (opts.clickCount || 1); i++) {
      el.dispatchEvent(new MouseEvent("click", init))
      if (i < (opts.clickCount || 1) - 1) await sleep(gaussian(120, 30))
    }
    if (typeof el.focus === "function") el.focus()
  }

  async function humanType(
    el,
    text,
    { delayMs, replace = false, pressEnter = false, typoRate = 0, human = true } = {},
  ) {
    if (!el) throw err("type target not found", "NOT_FOUND")
    if (!(el instanceof HTMLElement)) throw err("type target not editable", "NOT_EDITABLE")
    if (typeof el.focus === "function") el.focus()
    if (document.activeElement !== el) {
      // Recover if the site stole focus; otherwise keypresses go to body.
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
      el.focus()
    }
    if (replace) {
      if ("value" in el) {
        setNativeValue(el, "")
        el.dispatchEvent(new Event("input", { bubbles: true }))
      } else if (el.isContentEditable) {
        el.textContent = ""
      }
    }

    // Inter-keystroke timing model: base mean 95ms stddev 40ms, short burst
    // after whitespace, occasional long pauses ("thinking").
    const baseMean = typeof delayMs === "number" ? delayMs : 95
    const stddev = Math.max(10, baseMean * 0.35)

    function pushKey(ch) {
      const code = ch.length === 1 ? `Key${ch.toUpperCase()}` : ch
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code, bubbles: true }))
      if ("value" in el) {
        setNativeValue(el, (el.value || "") + ch)
        el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: ch, bubbles: true }))
      } else if (el.isContentEditable) {
        document.execCommand?.("insertText", false, ch)
      }
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, code, bubbles: true }))
    }

    function popChar() {
      if ("value" in el) {
        const v = el.value || ""
        setNativeValue(el, v.slice(0, -1))
        el.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", bubbles: true }))
      } else if (el.isContentEditable) {
        document.execCommand?.("delete")
      }
    }

    const neighbours = {
      a: "sq",
      e: "wr",
      i: "uo",
      o: "ip",
      s: "ad",
      t: "ry",
      n: "bm",
      l: "k",
      r: "et",
    }

    for (const ch of text) {
      // Simulate an occasional typo + correction when humanisation is on.
      if (human && typoRate > 0 && /[a-z]/i.test(ch) && Math.random() < typoRate) {
        const nb = neighbours[ch.toLowerCase()]
        if (nb) {
          const wrong = nb[Math.floor(Math.random() * nb.length)]
          pushKey(ch === ch.toUpperCase() ? wrong.toUpperCase() : wrong)
          await sleep(gaussian(baseMean * 1.4, stddev))
          popChar()
          await sleep(gaussian(baseMean * 0.8, stddev))
        }
      }
      pushKey(ch)
      let wait = human ? gaussian(baseMean, stddev) : baseMean
      if (ch === " ") wait *= 0.7
      if (human && Math.random() < 0.04) wait += gaussian(450, 180) // thinking pause
      await sleep(wait)
    }
    el.dispatchEvent(new Event("change", { bubbles: true }))
    if (pressEnter) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }))
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }))
      if (el.form && typeof el.form.requestSubmit === "function") el.form.requestSubmit()
    }
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
    if (setter) setter.call(el, value)
    else el.value = value
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function err(message, code = "INTERNAL", details) {
    const e = new Error(message)
    e.code = code
    if (details) e.details = details
    return e
  }

  // ---- Storage bridges ------------------------------------------------------
  function storageGet(storage, keys) {
    const out = {}
    if (Array.isArray(keys)) {
      for (const k of keys) out[k] = storage.getItem(k)
    } else if (typeof keys === "string") {
      out[keys] = storage.getItem(keys)
    } else {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i)
        out[k] = storage.getItem(k)
      }
    }
    return out
  }

  // ---- Handler table --------------------------------------------------------
  const handlers = {
    async "dom.snapshot"(args) {
      return buildSnapshot(args)
    },
    async "dom.fullSnapshot"(args) {
      return buildSnapshot({ ...args, mode: "full" })
    },
    async "dom.resolve"({
      role,
      name,
      nameMatch = "contains",
      ancestor,
      testId,
      attributes,
      visibleOnly = true,
      limit = 5,
    } = {}) {
      // Candidate gathering: start from a cheap CSS filter when possible,
      // then score each candidate by how many hints it matches.
      const candidates = new Set()
      if (testId) {
        for (const attr of ["data-testid", "data-test", "data-qa"]) {
          for (const el of document.querySelectorAll(`[${attr}="${cssEscapeAttr(testId)}"]`)) {
            candidates.add(el)
          }
        }
      }
      if (role) {
        const tags = roleToTags(role)
        const byRole = document.querySelectorAll(`[role="${cssEscapeAttr(role)}"]`)
        byRole.forEach((el) => candidates.add(el))
        tags.forEach((t) => document.querySelectorAll(t).forEach((el) => candidates.add(el)))
      }
      if (!candidates.size) {
        document.querySelectorAll("a,button,input,textarea,select,[role],[tabindex]").forEach((el) => candidates.add(el))
      }

      const needle = (name || "").toLowerCase().trim()
      function matchName(el) {
        if (!needle) return 0.5
        const n = accessibleName(el).toLowerCase()
        if (!n) return 0
        if (nameMatch === "exact") return n === needle ? 1 : 0
        if (nameMatch === "startsWith") return n.startsWith(needle) ? 0.9 : 0
        if (nameMatch === "regex") {
          try {
            return new RegExp(name, "i").test(n) ? 0.85 : 0
          } catch {
            return 0
          }
        }
        return n.includes(needle) ? 0.7 + (n === needle ? 0.3 : 0) : 0
      }

      function matchAncestor(el) {
        if (!ancestor) return 0.5
        let node = el.parentElement
        let hops = 0
        while (node && hops < 12) {
          const r = node.getAttribute?.("role") || implicitRole(node)
          const n = accessibleName(node).toLowerCase()
          if (ancestor.role && r === ancestor.role) return 0.9
          if (ancestor.name && n.includes(String(ancestor.name).toLowerCase())) return 0.85
          if (ancestor.selector && node.matches?.(ancestor.selector)) return 0.95
          node = node.parentElement
          hops += 1
        }
        return 0
      }

      function matchAttributes(el) {
        if (!attributes) return 0.5
        let score = 0
        let total = 0
        for (const [k, v] of Object.entries(attributes)) {
          total += 1
          if (el.getAttribute(k) === v) score += 1
        }
        return total ? score / total : 0.5
      }

      const scored = []
      for (const el of candidates) {
        if (visibleOnly && !isVisible(el)) continue
        const effectiveRole = el.getAttribute("role") || implicitRole(el)
        const roleScore = !role ? 0.5 : effectiveRole === role ? 1 : 0
        if (role && roleScore === 0) continue
        const nameScore = matchName(el)
        if (name && nameScore === 0) continue
        const score =
          roleScore * 0.35 +
          nameScore * 0.35 +
          matchAncestor(el) * 0.15 +
          matchAttributes(el) * 0.1 +
          (isVisible(el) ? 0.05 : 0)
        scored.push({ el, score })
      }

      scored.sort((a, b) => b.score - a.score)
      const top = scored.slice(0, limit).map(({ el, score }) => {
        const rect = el.getBoundingClientRect()
        return {
          ref: mintRef(el),
          score: Number(score.toFixed(3)),
          role: el.getAttribute("role") || implicitRole(el),
          name: accessibleName(el).slice(0, 160),
          tag: el.tagName.toLowerCase(),
          selector: stableSelector(el),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          visible: isVisible(el),
          disabled: !!el.disabled,
          inViewport:
            rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
        }
      })
      return {
        matches: top,
        ambiguous: top.length > 1 && top[0].score - (top[1]?.score ?? 0) < 0.08,
      }
    },
    async "dom.waitForSelector"({ selector, state = "visible", timeoutMs = 10_000 }) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const el = document.querySelector(selector)
        if (state === "detached") {
          if (!el) return { ok: true }
        } else if (el) {
          if (state === "attached") return { ok: true }
          if (state === "visible" && isVisible(el)) return { ok: true }
          if (state === "hidden" && !isVisible(el)) return { ok: true }
        }
        await sleep(80)
      }
      throw err(`waitForSelector timeout: ${selector}`, "TIMEOUT")
    },
    async "dom.click"(args) {
      const { timeoutMs = 10_000 } = args
      const start = Date.now()
      let el
      while (Date.now() - start < timeoutMs) {
        el = resolve(args)
        if (el && (args.force || isVisible(el))) break
        await sleep(100)
      }
      if (!el) throw err("click target not found", "NOT_FOUND")
      await humanClick(el, args)
      return { ok: true, selector: stableSelector(el) }
    },
    async "dom.type"(args) {
      const el = resolve(args)
      if (!el) throw err("type target not found", "NOT_FOUND")
      await humanType(el, args.text, args)
      return { ok: true }
    },
    async "dom.fill"({ fields, submit, human = true }) {
      const results = []
      for (const [sel, value] of Object.entries(fields)) {
        try {
          const el = resolve({ selector: sel })
          if (!el) {
            results.push({ selector: sel, ok: false, error: "not found" })
            continue
          }
          if (el.tagName === "SELECT") {
            el.value = value
            el.dispatchEvent(new Event("change", { bubbles: true }))
          } else if (el.type === "checkbox" || el.type === "radio") {
            if (!!value !== el.checked) el.click()
          } else {
            await humanType(el, String(value), { replace: true, human })
          }
          results.push({ selector: sel, ok: true })
        } catch (e) {
          results.push({ selector: sel, ok: false, error: e.message })
        }
      }
      if (submit) {
        const form = document.querySelector("form")
        if (form?.requestSubmit) form.requestSubmit()
        else if (form) form.submit()
      }
      return { results }
    },
    async "dom.select"({ selector, ref, value, label, index, multiple }) {
      const el = resolve({ selector, ref })
      if (!el || el.tagName !== "SELECT") throw err("select target not found", "NOT_FOUND")
      const opts = [...el.options]
      const toSelect = []
      if (Array.isArray(value)) value.forEach((v) => toSelect.push(opts.find((o) => o.value === v)))
      else if (value !== undefined) toSelect.push(opts.find((o) => o.value === value))
      if (label !== undefined) toSelect.push(opts.find((o) => o.label === label || o.text === label))
      if (typeof index === "number") toSelect.push(opts[index])
      if (!toSelect.filter(Boolean).length) throw err("no matching option", "NOT_FOUND")
      if (multiple) {
        opts.forEach((o) => (o.selected = toSelect.includes(o)))
      } else {
        el.value = toSelect[0].value
      }
      el.dispatchEvent(new Event("change", { bubbles: true }))
      return { ok: true, value: el.value }
    },
    async "dom.hover"(args) {
      const el = resolve(args)
      if (!el) throw err("hover target not found", "NOT_FOUND")
      el.scrollIntoView({ block: "center", behavior: "instant" })
      const rect = el.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, composed: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }
      el.dispatchEvent(new PointerEvent("pointerover", init))
      el.dispatchEvent(new MouseEvent("mouseover", init))
      return { ok: true }
    },
    async "dom.focus"(args) {
      const el = resolve(args)
      el?.focus?.()
      return { ok: !!el }
    },
    async "dom.blur"(args) {
      const el = resolve(args)
      el?.blur?.()
      return { ok: !!el }
    },
    async "dom.press"({ key, modifiers = [], selector, ref }) {
      const el = selector || ref ? resolve({ selector, ref }) : document.activeElement || document.body
      if (!el) throw err("focus target not found", "NOT_FOUND")
      const init = {
        key,
        bubbles: true,
        cancelable: true,
        shiftKey: modifiers.includes("Shift"),
        ctrlKey: modifiers.includes("Control"),
        altKey: modifiers.includes("Alt"),
        metaKey: modifiers.includes("Meta"),
      }
      el.dispatchEvent(new KeyboardEvent("keydown", init))
      el.dispatchEvent(new KeyboardEvent("keypress", init))
      el.dispatchEvent(new KeyboardEvent("keyup", init))
      return { ok: true }
    },
    async "dom.scroll"({ x, y, selector, ref, behavior = "smooth" }) {
      if (selector || ref) {
        const el = resolve({ selector, ref })
        el?.scrollIntoView({ block: "center", behavior })
      } else {
        window.scrollTo({ left: x ?? 0, top: y ?? 0, behavior })
      }
      return { ok: true, scrollX, scrollY }
    },
    async "dom.scrollIntoView"({ selector, ref, block = "center" }) {
      const el = resolve({ selector, ref })
      el?.scrollIntoView({ block })
      return { ok: !!el }
    },
    async "dom.getText"(args) {
      const el = resolve(args)
      return { text: el ? (el.innerText || el.textContent || "").trim() : null }
    },
    async "dom.getValue"(args) {
      const el = resolve(args)
      return { value: el ? el.value ?? null : null }
    },
    async "dom.getAttribute"({ selector, ref, name }) {
      const el = resolve({ selector, ref })
      return { value: el ? el.getAttribute(name) : null }
    },
    async "dom.getBoundingClientRect"(args) {
      const el = resolve(args)
      if (!el) return { rect: null }
      const r = el.getBoundingClientRect()
      return { rect: { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left } }
    },
    async "dom.query"({ selector }) {
      const el = document.querySelector(selector)
      return { found: !!el, ref: el ? mintRef(el) : null, selector: el ? stableSelector(el) : null }
    },
    async "dom.queryAll"({ selector, limit = 100 }) {
      const nodes = [...document.querySelectorAll(selector)].slice(0, limit)
      return {
        count: nodes.length,
        items: nodes.map((el) => ({
          ref: mintRef(el),
          selector: stableSelector(el),
          text: (el.innerText || "").slice(0, 120),
          tag: el.tagName.toLowerCase(),
        })),
      }
    },
    async "dom.evaluate"({ expression, args, awaitPromise, returnByValue }) {
      // Executes in ISOLATED world — page globals not available. This is a
      // deliberate safety boundary; use `dom.query` + structured tools for
      // page interaction.
      const fn = new Function("args", `return (async () => { return (${expression}) })()`)
      const result = await fn(args)
      return { result: returnByValue === false ? String(result) : result }
    },

    // Storage
    async "storage.local.get"({ key, keys }) {
      return { data: storageGet(localStorage, keys ?? key) }
    },
    async "storage.local.set"({ key, value }) {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value))
      return { ok: true }
    },
    async "storage.local.remove"({ key, keys }) {
      ;(Array.isArray(keys) ? keys : [key]).forEach((k) => localStorage.removeItem(k))
      return { ok: true }
    },
    async "storage.local.clear"() {
      localStorage.clear()
      return { ok: true }
    },
    async "storage.local.keys"() {
      const keys = []
      for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i))
      return { keys }
    },
    async "storage.session.get"({ key, keys }) {
      return { data: storageGet(sessionStorage, keys ?? key) }
    },
    async "storage.session.set"({ key, value }) {
      sessionStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value))
      return { ok: true }
    },
    async "storage.session.remove"({ key, keys }) {
      ;(Array.isArray(keys) ? keys : [key]).forEach((k) => sessionStorage.removeItem(k))
      return { ok: true }
    },
    async "storage.session.clear"() {
      sessionStorage.clear()
      return { ok: true }
    },
    async "storage.session.keys"() {
      const keys = []
      for (let i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i))
      return { keys }
    },
    async "storage.idb.databases"() {
      if (!indexedDB.databases) return { databases: [] }
      return { databases: await indexedDB.databases() }
    },
    async "storage.idb.read"({ name, store, key, limit = 100 }) {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(name)
        req.onerror = () => reject(err(req.error?.message || "IDB open failed", "IDB_ERROR"))
        req.onsuccess = () => {
          const db = req.result
          try {
            const tx = db.transaction(store, "readonly")
            const os = tx.objectStore(store)
            if (key !== undefined) {
              const gr = os.get(key)
              gr.onsuccess = () => {
                db.close()
                resolve({ value: gr.result })
              }
              gr.onerror = () => {
                db.close()
                reject(err(gr.error?.message, "IDB_ERROR"))
              }
            } else {
              const out = []
              const cur = os.openCursor()
              cur.onsuccess = (e) => {
                const c = e.target.result
                if (c && out.length < limit) {
                  out.push({ key: c.key, value: c.value })
                  c.continue()
                } else {
                  db.close()
                  resolve({ items: out })
                }
              }
              cur.onerror = () => {
                db.close()
                reject(err(cur.error?.message, "IDB_ERROR"))
              }
            }
          } catch (e) {
            db.close()
            reject(err(e.message, "IDB_ERROR"))
          }
        }
      })
    },
  }

  // ---- Runtime message plumbing --------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return
    const fn = handlers[msg.type]
    if (!fn) return
    Promise.resolve()
      .then(() => fn(msg))
      .then((result) => sendResponse(result ?? { ok: true }))
      .catch((e) => sendResponse({ error: e.message, code: e.code || "INTERNAL" }))
    return true
  })

  // ---- Behavior capture -----------------------------------------------------
  const capture = {
    enabled: false,
    queue: [],
    flushTimer: null,
  }
  function emit(event) {
    if (!capture.enabled) return
    capture.queue.push({ ...event, t: Date.now(), url: location.href })
    if (capture.queue.length >= 25) flush()
    else if (!capture.flushTimer) capture.flushTimer = setTimeout(flush, 1000)
  }
  function flush() {
    if (!capture.queue.length) return
    const batch = capture.queue.splice(0, capture.queue.length)
    clearTimeout(capture.flushTimer)
    capture.flushTimer = null
    chrome.runtime.sendMessage({ type: "behavior.events", events: batch }).catch(() => {})
  }

  handlers["behavior.configure"] = async ({ enabled }) => {
    capture.enabled = !!enabled
    if (!enabled) flush()
    return { ok: true, enabled: capture.enabled }
  }

  function safeDescribe(el) {
    if (!el || el.nodeType !== 1) return null
    return {
      tag: el.tagName.toLowerCase(),
      selector: stableSelector(el),
      role: el.getAttribute("role") || implicitRole(el),
      name: accessibleName(el).slice(0, 100),
      type: el.getAttribute?.("type"),
    }
  }

  addEventListener(
    "click",
    (e) => {
      emit({ kind: "click", target: safeDescribe(e.target), x: e.clientX, y: e.clientY, button: e.button })
    },
    true,
  )
  addEventListener(
    "input",
    (e) => {
      const t = e.target
      const type = t?.type
      // Redact sensitive inputs.
      const redacted = ["password", "credit-card", "cc-number"].some((k) =>
        (t?.autocomplete || "").toLowerCase().includes(k),
      ) || type === "password"
      emit({ kind: "input", target: safeDescribe(t), value: redacted ? "<redacted>" : String(t?.value || "").slice(0, 100) })
    },
    true,
  )
  addEventListener(
    "submit",
    (e) => {
      emit({ kind: "submit", target: safeDescribe(e.target) })
    },
    true,
  )
  addEventListener(
    "keydown",
    (e) => {
      if (["Enter", "Escape", "Tab"].includes(e.key)) emit({ kind: "key", key: e.key })
    },
    true,
  )

  chrome.runtime.sendMessage({ type: "content.ready", url: location.href, ts: Date.now() }).catch(() => {})
})()
