/** Native messaging transport — stub (no host configured). */
export function create({ router, clientId }) {
  return {
    send: () => {},
    close: () => {},
    isConnected: () => false,
  };
}
