/**
 * tools/aliases.js — legacy method-name compatibility layer.
 *
 * The Hugging Face server (server.js) and existing agents call tools with
 * flat snake_case names like `tabs_list`, `navigate`, `click_element`. The
 * canonical new API uses dotted namespaces (`tabs.list`, `nav.goto`,
 * `dom.click`). Instead of forcing every client to upgrade in lockstep, we
 * register every legacy name as an alias that forwards to the canonical
 * handler with any required param translation.
 *
 * Adding a new alias:
 *   - If only the name changed: `alias("old_name", "new.name")`
 *   - If params need reshaping: `alias("old_name", "new.name", (p) => ({...}))`
 */

import { createLogger } from "../core/logger.js"

const log = createLogger("aliases")

function makeAlias(router, legacyName, canonicalName, mapParams = (p) => p) {
  router.register(legacyName, async (params, ctx) => {
    const mapped = mapParams(params || {}, ctx) || {}
    return router.invoke(canonicalName, mapped, ctx)
  }, { description: `alias for ${canonicalName}`, category: "legacy" })
}

export function register(router) {
  const alias = (legacy, canonical, map) => makeAlias(router, legacy, canonical, map)

  // --- Tabs -----------------------------------------------------------------
  alias("tabs_list", "tabs.list")
  alias("tabs_get", "tabs.get")
  alias("tabs_create", "tabs.create", (p) => ({ ...p, url: p.url }))
  alias("tabs_close", "tabs.close", (p) => ({ tabIds: p.tabIds || (p.tabId != null ? [p.tabId] : []) }))
  alias("tabs_activate", "tabs.activate")
  alias("tabs_update", "tabs.create", (p) => ({ ...p })) // legacy "update" was often a create-or-navigate
  alias("tabs_reload", "tabs.reload")
  alias("tabs_duplicate", "tabs.duplicate")
  alias("tabs_move", "tabs.move")

  // --- Navigation -----------------------------------------------------------
  alias("navigate", "nav.goto", (p) => ({ tabId: p.tabId, url: p.url, waitUntil: p.waitUntil, timeoutMs: p.timeoutMs }))
  alias("go_back", "nav.back")
  alias("go_forward", "nav.forward")
  alias("reload", "nav.reload")
  alias("wait_for_element", "nav.waitForSelector", (p) => ({ tabId: p.tabId, selector: p.selector, state: p.state, timeoutMs: p.timeout ?? p.timeoutMs }))
  alias("wait_for_navigation", "nav.waitForLoad")
  alias("wait_for_url", "nav.waitForURL")

  // --- DOM actions ----------------------------------------------------------
  alias("click_element", "dom.click", (p) => ({ tabId: p.tabId, selector: p.selector, ref: p.ref, button: p.button, clickCount: p.clickCount, human: p.human }))
  alias("dblclick_element", "dom.dblclick", (p) => ({ tabId: p.tabId, selector: p.selector, ref: p.ref }))
  alias("type_text", "dom.type", (p) => ({ tabId: p.tabId, selector: p.selector, ref: p.ref, text: p.text, replace: p.clear ?? p.replace, pressEnter: p.submit ?? p.pressEnter, delayMs: p.delayMs, human: p.human }))
  alias("fill_form", "dom.fill", (p) => ({ tabId: p.tabId, fields: p.fields, submit: p.submit, human: p.human }))
  alias("smart_fill_form", "dom.fill", (p) => ({ tabId: p.tabId, fields: p.fields ?? p.profile, submit: p.submit, human: true }))
  alias("hover_element", "dom.hover")
  alias("focus_element", "dom.focus")
  alias("press_key", "dom.press", (p) => ({ tabId: p.tabId, key: p.key, modifiers: p.modifiers }))
  alias("scroll_to", "dom.scroll", (p) => ({ tabId: p.tabId, x: p.x, y: p.y, selector: p.selector }))
  alias("select_option", "dom.select")

  // --- DOM reads ------------------------------------------------------------
  alias("get_text", "dom.getText")
  alias("get_value", "dom.getValue")
  alias("get_attribute", "dom.getAttribute", (p) => ({ tabId: p.tabId, selector: p.selector, ref: p.ref, name: p.name ?? p.attribute }))
  alias("get_html", "dom.evaluate", (p) => ({ tabId: p.tabId, expression: `document.documentElement.outerHTML` }))
  alias("query_shadow_dom", "dom.query", (p) => ({ tabId: p.tabId, selector: p.selector }))
  alias("click_shadow_element", "dom.click", (p) => ({ tabId: p.tabId, selector: p.selector, ref: p.ref }))
  alias("execute_script", "dom.evaluate", (p) => ({ tabId: p.tabId, expression: p.script ?? p.expression, args: p.args }))
  alias("inject_css", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(p.css || p.style || "")}; document.head.appendChild(s); return { ok: true } })()`,
  }))
  alias("get_page_info", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `({ url: location.href, title: document.title, readyState: document.readyState })`,
  }))
  alias("get_all_links", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `Array.from(document.querySelectorAll('a[href]')).slice(0, 500).map(a => ({ href: a.href, text: (a.innerText||'').trim().slice(0,120) }))`,
  }))
  alias("get_all_inputs", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `Array.from(document.querySelectorAll('input,textarea,select')).slice(0, 300).map(el => ({ tag: el.tagName.toLowerCase(), type: el.type||null, name: el.name||null, id: el.id||null, placeholder: el.placeholder||null, value: String(el.value||'').slice(0,200) }))`,
  }))

  // --- Snapshots + refs -----------------------------------------------------
  alias("snapshot", "dom.snapshot")
  alias("observe", "dom.fullSnapshot")
  alias("click_ref", "dom.click", (p) => ({ tabId: p.tabId, ref: p.ref, human: true }))
  alias("hover_ref", "dom.hover", (p) => ({ tabId: p.tabId, ref: p.ref }))
  alias("type_ref", "dom.type", (p) => ({ tabId: p.tabId, ref: p.ref, text: p.text, replace: true }))

  // --- Screenshots ----------------------------------------------------------
  alias("screenshot", "dom.screenshot", (p) => ({ tabId: p.tabId, format: p.format ?? "png", quality: p.quality, fullPage: false }))
  alias("screenshot_full", "dom.screenshot", (p) => ({ tabId: p.tabId, format: p.format ?? "png", quality: p.quality, fullPage: true }))
  alias("screenshot_annotated", "dom.screenshot", (p) => ({ tabId: p.tabId, format: "png", fullPage: false }))

  // --- Cookies --------------------------------------------------------------
  alias("get_cookies", "cookies.getAll")
  alias("set_cookie", "cookies.set")
  alias("delete_cookie", "cookies.remove")
  alias("clear_cookies", "cookies.clearForDomain", (p) => ({ domain: p.domain }))
  alias("export_all_cookies", "cookies.getAll", (p) => ({ domain: p.domain }))
  alias("import_cookies", "cookies.set", (p) => ({ ...p }))
  alias("rotate_cookies", "cookies.clearForDomain")

  // --- Storage --------------------------------------------------------------
  alias("storage_get", "storage.local.get")
  alias("storage_set", "storage.local.set")
  alias("storage_clear", "storage.local.clear")

  // --- Network --------------------------------------------------------------
  alias("get_network_requests", "net.events", (p) => ({ tabId: p.tabId, since: p.since, limit: p.limit ?? 200 }))
  alias("block_url", "net.block", (p) => ({ urlPatterns: Array.isArray(p.pattern) ? p.pattern : [p.pattern ?? p.url] }))
  alias("network_capture_start", "net.observe")
  alias("network_capture_stop", "net.stop")

  // --- Sessions -------------------------------------------------------------
  alias("save_session", "session.capture")
  alias("restore_session", "session.restore")

  // --- Meta / stealth / misc -----------------------------------------------
  alias("health", "system.health")
  alias("list_tools", "system.capabilities")
  alias("get_extension_info", "system.version")
  alias("offscreen_status", "system.health")
  alias("clear_logs", "net.stop") // best-effort — clears capture buffer
  alias("enable_stealth", "system.ping") // stealth is built-in/passive now
  alias("stealth_status", "system.ping")
  alias("advanced_stealth", "system.ping")
  alias("evasion_mode", "system.ping")
  alias("rotate_fingerprint", "system.ping")
  alias("get_fingerprint", "system.ping")
  alias("rotate_user_agent", "net.setUserAgent", (p) => ({ tabId: p.tabId, userAgent: p.userAgent }))
  alias("set_referrer", "net.setExtraHeaders", (p) => ({ tabId: p.tabId, headers: { Referer: p.referrer || p.referer } }))
  alias("set_proxy", "system.ping") // proxy changes require optional "proxy" permission grant
  alias("clear_proxy", "system.ping")
  alias("detect_challenges", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `(() => ({
      cloudflare: !!document.querySelector('[class*="cf-"], #challenge-running'),
      turnstile: !!document.querySelector('iframe[src*="turnstile"], [data-sitekey][class*="cf"]'),
      recaptcha: !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha'),
      hcaptcha: !!document.querySelector('iframe[src*="hcaptcha"], .h-captcha'),
      datadome: !!document.querySelector('[class*="datadome"], [id*="datadome"]'),
    }))()`,
  }))
  alias("detect_recaptcha", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `(() => ({
      v2: !!document.querySelector('iframe[src*="recaptcha/api2"], .g-recaptcha'),
      v3: !!document.querySelector('script[src*="recaptcha/api.js"]'),
      hcaptcha: !!document.querySelector('iframe[src*="hcaptcha"], .h-captcha'),
    }))()`,
  }))
  alias("bypass_cloudflare", "nav.waitForNetworkIdle", (p) => ({ tabId: p.tabId, timeoutMs: p.timeoutMs ?? 30_000 }))
  alias("bypass_cloudflare_turnstile", "dom.click", (p) => ({ tabId: p.tabId, selector: 'iframe[src*="turnstile"]' }))
  alias("solve_recaptcha_checkbox", "dom.click", (p) => ({ tabId: p.tabId, selector: 'iframe[src*="recaptcha"]' }))
  alias("detect_bot_protection", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `(() => {
      const sig = document.documentElement.outerHTML.slice(0, 200_000).toLowerCase();
      return {
        datadome: sig.includes('datadome'),
        perimeterx: sig.includes('px-captcha') || sig.includes('perimeterx'),
        akamai: sig.includes('akam') && sig.includes('sensor_data'),
        distil: sig.includes('distil_'),
        imperva: sig.includes('iv-token') || sig.includes('imperva'),
        shape: sig.includes('f5_') || sig.includes('shape security'),
      };
    })()`,
  }))
  alias("randomize_behavior", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `(() => { const n = ${p?.count ?? 5}; for (let i=0;i<n;i++) setTimeout(() => window.scrollBy({top: (Math.random()-0.5)*200, behavior:'smooth'}), i*400 + Math.random()*600); return { scheduled: n } })()`,
  }))
  alias("simulate_human_behavior", "randomize_behavior")

  // --- Recording -----------------------------------------------------------
  alias("start_recording", "behavior.start", (p) => ({ scope: p.scope ?? "tab", tabId: p.tabId }))
  alias("stop_recording", "behavior.stop")
  alias("recording_status", "behavior.status")

  // --- Misc convenience -----------------------------------------------------
  alias("list_iframes", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `Array.from(document.querySelectorAll('iframe')).map(f => { try { const r=f.getBoundingClientRect(); return { src: f.src, sameOrigin: (()=>{ try { const _=f.contentWindow?.location?.href; return true } catch { return false } })(), visible: r.width>1 && r.height>1, width: Math.round(r.width), height: Math.round(r.height) } } catch(e){ return { src: f.src, error: String(e.message) } } })`,
  }))
  alias("interact_iframe", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `(() => { const f = document.querySelectorAll('iframe')[${Number(p.index) || 0}]; if (!f) return { ok: false, reason: 'no iframe' }; try { const d = f.contentDocument; if (!d) return { ok: false, reason: 'cross-origin' }; const el = d.querySelector(${JSON.stringify(p.selector || "body")}); if (${JSON.stringify(p.action || "read")} === 'click') { el?.click(); return { ok: true, action: 'click' } } return { ok: true, text: (el?.innerText||'').slice(0,2000) } } catch(e){ return { ok: false, error: String(e.message) } } })()`,
  }))
  alias("handle_rate_limit", "net.throttle", (p) => ({ tabId: p.tabId, latencyMs: p.latencyMs ?? 800 }))
  alias("extract_prolific_studies", "dom.evaluate", (p) => ({
    tabId: p.tabId,
    expression: `Array.from(document.querySelectorAll('[data-testid*="study"], [class*="study-card"], [class*="StudyCard"]')).slice(0, 100).map(el => ({ text: (el.innerText||'').trim().slice(0,600), href: el.querySelector('a')?.href || null }))`,
  }))

  log.info(`legacy aliases registered`)
}
