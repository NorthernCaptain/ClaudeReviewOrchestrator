# http-client

A small `fetch` wrapper that retries failed requests.

## Options

| Option      | Default | Meaning                                              |
| ----------- | ------- | ---------------------------------------------------- |
| `retries`   | `3`     | How many more times a failed request is attempted.   |
| `timeoutMs` | `5000`  | Timeout for each attempt, in milliseconds.           |
