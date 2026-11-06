// Lets session.js be imported in tests without installing its dependencies. The QR image is the only thing it
// needs from "qrcode" before a real connection is made, and "baileys" is replaced by whatever a test puts in
// globalThis.__baileys (for the downloads); tests never connect to WhatsApp.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'qrcode') {
    return {
      url: 'data:text/javascript,export default { toDataURL: async () => "data:image/png;base64,AA==" }',
      shortCircuit: true,
    }
  }
  if (specifier === 'baileys') {
    const code = [
      'const g = () => globalThis.__baileys || {}',
      'export default function makeWASocket(...a) { return g().makeWASocket(...a) }',
      'export const downloadMediaMessage = (...a) => g().downloadMediaMessage(...a)',
      'export const useMultiFileAuthState = (...a) => g().useMultiFileAuthState(...a)',
      'export const DisconnectReason = {}',
      'export const Browsers = {}',
    ].join('\n')
    return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
