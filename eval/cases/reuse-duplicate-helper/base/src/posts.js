/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { slugify } from "./text.js"

export const postUrl = (post) => `/posts/${slugify(post.title)}`
