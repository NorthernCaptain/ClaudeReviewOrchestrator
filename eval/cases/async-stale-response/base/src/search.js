/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Search-as-you-type: every keystroke calls search(); responses can arrive
// in any order.
export const createSearch = (api, render) => {
    const state = { query: "", results: [], loading: false }
    let latest = 0

    const search = async (query) => {
        const seq = ++latest
        state.query = query
        state.loading = true
        render(state)
        const results = await api.search(query)
        if (seq !== latest) return
        state.results = results
        state.loading = false
        render(state)
    }

    return { search, state }
}
