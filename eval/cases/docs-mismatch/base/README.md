# http-client

A small fetch wrapper with retries.

## Options

| Option      | Default | Meaning                                  |
| ----------- | ------- | ---------------------------------------- |
| `retries`   | `3`     | Attempts after the first failed request. |
| `timeoutMs` | `5000`  | Per-attempt timeout.                     |
