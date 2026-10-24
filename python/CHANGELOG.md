# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A refusal's body is read as a problem document whenever it parses as a JSON object, whatever its `Content-Type`.
- A refusal with no valid code reads `HTTP <status> with no refusal code: <text>`, the text taken from the body's `detail`, `title`, legacy `error` or the invalid code, in that order. Before, the message was the reason phrase and the legacy `error` text was lost.
- A refusal code is lower-case snake case of at most 64 characters. A longer one reads as `refusal_without_code`.
- A refusal's message quotes at most 1,000 characters of server text. `detail` keeps it whole.
- A trace id that is not an HTTP token is dropped.
- A response body must be UTF-8 JSON, with one leading byte order mark allowed, and may not hold `NaN` or `Infinity`.
- `result(timeout=t)` and `fetch` cut a poll wait that would pass the deadline to end at it and poll once more, with one attempt of the client's `timeout`. When that poll reads the build done, the files route and the signed download each get one attempt of the client's `timeout`, so the call returns the data and can run past `t` by one client timeout per request. Before, the client raised as soon as the next wait would cross the deadline, without that poll.
- An operation whose status is not `pending`, `running`, `done` or `failed`, a poll that answers for another operation, or a failed operation whose error `status` is not an integer from 400 to 599 raises `ContractError` (`contract_violation`) on the read that carries it.
- A ref whose stored version lists its digest only under another rendering raises `FormatError` (`format_invalid` at `/members/<i>/artifact/rendering`) before any download.
- `strict` that is not a bool, or `progress` that is not a bool or None, raises `invalid_argument` before any request.
- A synchronous client calls its header provider on the caller's thread without a time limit.

### Fixed

- The client's key is redacted from server text when the server splits it with a control character, a format character or another default-ignorable code point, such as a bidirectional mark, a zero-width space, a byte order mark, a word joiner, a soft hyphen, a combining grapheme joiner, a variation selector or a Hangul filler, which the shown text would otherwise drop or not draw and so rejoin the key. Shown server text drops every format character and every default-ignorable code point.
- The client's key is redacted from every JSON body the client reads, success bodies included, so a manifest warning that echoes it reaches `DataWarning` as `[redacted]`. A value a `contract_violation` message quotes is redacted before `repr` escapes any of its characters.
- A retryable failure that the poll at the deadline reads raises that failure, where the client resubmitted the build with no time left and raised `deadline_exceeded`.
- The client's key is redacted from the member names of a refusal's `problem`, and a trace id, in the body or the `x-dfo-trace-id` header, that holds the key the request carried is dropped.
- A `contract_violation` message that quotes an operation's status, a failed operation's error `status` or a URL the server named quotes at most 1,000 characters, with the client's key redacted.
- A URL the server names for a file or a docs page follows one rule read from its text: a path that starts with exactly one `/`, or an http or https URL on the API's origin with no `@`, `%` or `\` in its authority, and no control character or `.` or `..` segment, raw or percent-encoded, between slashes or backslashes, raw or percent-encoded as `%2F` or `%5C`. Any other form, such as `//host/x`, `/\host/x`, `https:x`, `x/y`, userinfo or a host with a trailing dot, raises `ContractError` (`contract_violation`) for a file before any request, and leaves `docs_url` None. An accepted URL resolves to the API's origin followed by its path. A `docs_url` on an http API is kept, where only an https one was. A `.` or `..` segment ended by `%2F` or `%5C` counts in `base_url`, `client.request` paths and `graph.node` dcids too.
- `Content-Length`, `Transfer-Encoding`, `Host`, `Connection`, `Keep-Alive`, `TE`, `Trailer` and `Upgrade` in `default_headers`, the header provider or a request's headers raise `header_invalid`, where `Content-Length` used to escape as an `h11` protocol error.
- An async client's header provider that never answers is bounded by the attempt's time left and raises `deadline_exceeded`.
- A UTF-16 or UTF-32 body reads as one that is not JSON, so a deeply nested one cannot slip past the depth guard and raise `RecursionError`.
- A refusal body past 16 MiB raises the class of its status, retryable as the status is, where it raised `response_too_large`.
- A `base_url` that is not a string raises `base_url_invalid`, where it raised `TypeError`.
- Closing a client while a request is in flight raises `NetworkError` naming the close, where the reason was empty.
- A refused poll's `Retry-After` is held to 1 to 60 seconds, so `Retry-After: 0` on a 429 no longer polls without pause until the deadline.
- A long build whose download runs out of time, in `result` or in `fetch`, raises `deadline_exceeded` naming the `client.operation(...)` call that resumes it.
- A manifest's `bytes` for an artifact can only lower the 2 GiB download cap.
- A FIFO, directory or device at a cache entry's path is a cache miss, where a FIFO used to block the fetch.
- `progress_line` draws no wider than its bar when the estimate or the row count is negative.
- The `warnings` registry keeps at most 1,024 warning texts from the client, where it kept every distinct server warning text in the caller's module.
- A credentials file the client refuses names the format it accepts: `[profile]` headers, `name = "value"` entries in double quotes, blank lines and whole-line `#` comments.
