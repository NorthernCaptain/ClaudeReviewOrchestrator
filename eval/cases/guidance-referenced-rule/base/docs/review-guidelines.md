# Review guidelines

- Every new customer-visible behaviour ships behind a feature flag declared in
  `src/flags.js` with a default of `false`, and the code checks it with
  `isEnabled(<flag>)`. Changes that alter pricing, shipping or checkout
  without a flag are not accepted.
- Prices are integer cents.
