/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { readFileSync } from "node:fs"
import { readPackageVersion, VERSION } from "./version.js"

const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
)

describe("readPackageVersion", () => {
    test("reads package.json's version now, not once at startup", () => {
        expect(readPackageVersion()).toBe(pkg.version)
        expect(readPackageVersion(() => '{"version":"9.9.9"}')).toBe("9.9.9")
        expect(VERSION).toBe(pkg.version)
    })

    test("unknown when package.json can't be read, parsed or has no version", () => {
        expect(
            readPackageVersion(() => {
                throw new Error("ENOENT")
            })
        ).toBe("unknown")
        expect(readPackageVersion(() => "{ half")).toBe("unknown")
        expect(readPackageVersion(() => "{}")).toBe("unknown")
    })
})
