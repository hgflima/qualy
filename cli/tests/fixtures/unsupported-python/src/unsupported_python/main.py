"""Entry point for the unsupported-python fixture demo script."""

from unsupported_python.utils import greet


def main() -> int:
    print(greet("world"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
