/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { parseJsonc, skipBlank } from "./jsonc.mjs"

describe("skipBlank", () => {
    test("skips whitespace and both comment kinds", () => {
        const text = " // a\n /* b */ x"
        expect(text[skipBlank(text, 0)]).toBe("x")
        expect(skipBlank("// only", 0)).toBe(7)
    })
})

describe("parseJsonc", () => {
    test("reads JSON with comments, escapes and nested arrays", async () => {
        const root = parseJsonc(
            '/* lead */ {"s": "a\\"b // not a comment", "n": [1, -2.5e3, true, null, {"x": []}], // c\n "o": {}}'
        )
        expect(root.value).toEqual({
            s: 'a"b // not a comment',
            n: [1, -2500, true, null, { x: [] }],
            o: {},
        })
        expect(root.members.map((m) => m.key)).toEqual(["s", "n", "o"])
    })

    test("keeps __proto__ as a plain key", async () => {
        const value = parseJsonc('{"__proto__": {"polluted": 1}}').value
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
        expect(Object.keys(value)).toEqual(["__proto__"])
    })

    test.each([
        ['{"a": 1', "expected ',' or '}'"],
        ['{"a" 1}', "expected ':'"],
        ["{a: 1}", "expected a key"],
        ['{"a": "x\n"}', "unterminated string"],
        ['{"a": 1} x', "unexpected text after the value"],
        ['{"a": nope}', "unexpected character"],
        ["[1 2]", "expected ',' or ']'"],
        ['{"a": 1,}', "expected a key"],
        ["[1,]", "unexpected character"],
        ["[,]", "unexpected character"],
        ['{"a": 1} /* open', "unterminated comment at offset 9"],
    ])("rejects %j", (text, message) => {
        expect(() => parseJsonc(text)).toThrow(message)
    })
})
