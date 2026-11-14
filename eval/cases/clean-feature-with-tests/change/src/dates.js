/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Day of week in UTC: 0 = Sunday … 6 = Saturday.
export const utcDay = (date) => date.getUTCDay()

const SUNDAY = 0
const SATURDAY = 6

// Whether the date falls on a Saturday or Sunday in UTC.
export const isWeekend = (date) => {
    const day = utcDay(date)
    return day === SATURDAY || day === SUNDAY
}
