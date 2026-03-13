from functools import wraps
from typing import Callable, TypeVar

from flask import abort, current_app, has_request_context, redirect, request, session, url_for

F = TypeVar("F", bound=Callable)


SESSION_AUTH_KEY = "is_authenticated"


def is_authenticated() -> bool:
    """Return whether the current session has passed the shared-password gate."""
    return bool(session.get(SESSION_AUTH_KEY))


def login_with_password(password: str) -> bool:
    """Validate the shared password and mark the session as authenticated."""
    expected = current_app.config.get("SHARED_PASSWORD")
    if not expected:
        return False
    if password == expected:
        if has_request_context():
            session[SESSION_AUTH_KEY] = True
        return True
    return False


def require_auth(func: F) -> F:
    """Wrap a route so unauthenticated users are redirected or rejected."""
    @wraps(func)
    def wrapper(*args, **kwargs):
        """Enforce the shared-password session check for a single request."""
        if not is_authenticated():
            if request.is_json:
                abort(401)
            return redirect(url_for("app.login"))
        return func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]
