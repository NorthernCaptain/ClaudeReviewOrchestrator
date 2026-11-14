/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

export const canExportReports = (user) =>
    user.role === "admin" || user.role === "manager"
