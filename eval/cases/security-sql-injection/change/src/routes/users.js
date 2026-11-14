/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

export const registerUserRoutes = (app, db) => {
    app.get("/users/:id", async (req, res) => {
        const rows = await db.query(
            "SELECT id, name, email FROM users WHERE id = $1",
            [req.params.id]
        )
        if (rows.length === 0) return res.status(404).end()
        res.json(rows[0])
    })

    app.get("/users", async (req, res) => {
        const name = req.query.name ?? ""
        const rows = await db.query(
            `SELECT id, name, email FROM users WHERE name LIKE '%${name}%' LIMIT 50`
        )
        res.json(rows)
    })
}
