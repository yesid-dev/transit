from importlib.metadata import distribution

import duckdb


def main() -> None:
    wheel = distribution("duckdb-core-ext-httpfs")
    binary = next(
        (file for file in wheel.files or () if file.name == "httpfs.duckdb_extension"), None
    )
    if binary is None:
        raise RuntimeError("The locked httpfs wheel does not contain its extension binary")

    with duckdb.connect() as connection:
        connection.install_extension(str(wheel.locate_file(binary)))
        connection.load_extension("httpfs")


if __name__ == "__main__":
    main()
