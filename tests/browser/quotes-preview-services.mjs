export * from './system-preview-services.mjs'
import { state, getDoc, getDocs } from './services.mjs'
// Real PriceProvider subscribes to documents; the shared fixture's original
// onSnapshot is a collection subscription. Emit the appropriate shape here.
export const onSnapshot = (reference, options, callback) => {
    const next = typeof options === 'function' ? options : callback
    let active = true
    ;(reference.id ? getDoc(reference) : getDocs(reference)).then(value => { if (active) next(value) })
    return () => { active = false }
}
export { state }
