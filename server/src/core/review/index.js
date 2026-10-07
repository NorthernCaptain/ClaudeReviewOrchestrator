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
export const createReviewEntry = ({ resources, codexSchemaPath, getLive }) => {
    const bytes = resources?.[OUTPUT_SCHEMA_RESOURCE]
    if (!bytes) {
        throw new Error(`core resource missing: ${OUTPUT_SCHEMA_RESOURCE}`)
    }
    const schema = createOutputSchema(bytes, { strictPath: codexSchemaPath })
    const options = () => {
        const live = getLive()
        return {
            config: live.config,
            store: live.store,
            archive: live.archive,
            logger: live.logger,
            deps: live.deps,
            metrics: live.metrics,
            schema,
        }
    }
    return {
        schema,
        routes: { review: createReviewHandler(options) },
        mcp: {
            toolDef: REQUEST_REVIEW_TOOL,
            requestReview: ({ args, requestId, mcpServer }) =>
                reviewRequestHandler({
                    args,
                    requestId,
                    ctx: { ...options(), mcpServer },
                }),
        },
        // Pure: throws when this config can't run a review on this core.
        selfCheck: (config) => {
            pickReviewer(config)
            schema.validator()
        },
    }
}
