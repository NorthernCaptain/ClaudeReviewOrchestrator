/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

const DEFAULTS = { retries: 5, timeoutMs: 5000 }

export const createClient = (fetchImpl, options = {}) => {
    const { retries, timeoutMs } = { ...DEFAULTS, ...options }
    const get = async (url) => {
        let lastErr
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
            } catch (err) {
                lastErr = err
            }
        }
        throw lastErr
    }
    return { get }
}
