/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { ROLE } from "./roles.js"

export const canManageUsers = (user) => user.role === ROLE.ADMIN
