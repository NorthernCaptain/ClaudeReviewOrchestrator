/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Search-as-you-type: every keystroke calls search(); responses can arrive
// in any order.
export const createSearch = (api, render) => {
    const state = { query: "", results: [], loading: false, error: null }

    const search = async (query) => {
        state.query = query
        state.loading = true
        state.error = null
        render(state)
        try {
            state.results = await api.search(query)
        } catch (err) {
            state.error = err.message
        }
        state.loading = false
        render(state)
    }

    return { search, state }
}
