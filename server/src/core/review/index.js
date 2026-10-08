/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The review entry. Its static-import closure is the review path, the
// code `reviewVersion` covers (hot-reload plan §5.3), so it must never
// import UI modules (dashboard, status, provider, …); those import it.

import { REQUEST_REVIEW_TOOL, reviewRequestHandler } from "./mcp.js"
import { createReviewHandler } from "./review.js"
import { pickReviewer } from "./reviewer.js"
import { createOutputSchema, OUTPUT_SCHEMA_RESOURCE } from "./schema.js"

// The review half of a core. `resources` are the bytes the shell read at
// load; `getLive` returns the attached live capabilities.
// `versions` ({ reviewVersion, shellVersion, coreVersion }) feed the review
// key and the duplicate key.
export const createReviewEntry = ({
    resources,
    codexSchemaPath,
    versions = {},
    getLive,
}) => {
    const bytes = resources?.[OUTPUT_SCHEMA_RESOURCE]
    if (!bytes) {
        throw new Error(`core resource missing: ${OUTPUT_SCHEMA_RESOURCE}`)
    }
    const schema = createOutputSchema(bytes, { strictPath: codexSchemaPath })
    // A review runs on the config the shell pinned when it admitted it.
    const options = (request) => {
        const live = getLive()
        return {
            config: request?.config ?? live.config,
            store: live.store,
            archive: live.archive,
            logger: live.logger,
            deps: live.deps,
            metrics: live.metrics,
            schema,
            versions,
        }
    }
    return {
        schema,
        routes: { review: createReviewHandler(options) },
        mcp: {
            toolDef: REQUEST_REVIEW_TOOL,
            requestReview: ({ args, requestId, mcpServer, request }) =>
                reviewRequestHandler({
                    args,
                    requestId,
                    ctx: { ...options(request), mcpServer },
                }),
        },
        // Pure: throws when this config can't run a review on this core.
        selfCheck: (config) => {
            pickReviewer(config)
            schema.validator()
        },
    }
}
