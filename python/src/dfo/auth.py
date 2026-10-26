"""API keys and request headers.

`login()` is the notebook form of `dfo auth login`: it stores a key in the
credentials file. `ApiKey` masks a key in every repr, and `ApiKeyArgument` is
what a client's `api_key` takes. A `HeaderProvider` or `AsyncHeaderProvider`
adds headers, such as an identity token, before every request.
"""

from dfo._client.cli import login
from dfo._config.keys import ApiKey, ApiKeyArgument
from dfo._http.hooks import AsyncHeaderProvider, HeaderProvider

__all__ = [
    "ApiKey",
    "ApiKeyArgument",
    "AsyncHeaderProvider",
    "HeaderProvider",
    "login",
]
