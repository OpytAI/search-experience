BunInfo = provider(
    doc = "Bun runtime executable.",
    fields = {
        "bun": "The Bun executable file.",
    },
)

def _bun_toolchain_impl(ctx):
    return [
        platform_common.ToolchainInfo(
            buninfo = BunInfo(bun = ctx.file.bun),
        ),
    ]

bun_toolchain = rule(
    implementation = _bun_toolchain_impl,
    attrs = {
        "bun": attr.label(
            allow_single_file = True,
            mandatory = True,
        ),
    },
    doc = "Declare a Bun executable as a Bazel toolchain.",
)
