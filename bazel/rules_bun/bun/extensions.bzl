load("//bun/private:repositories.bzl", "DEFAULT_BUN_VERSION", "bun_install", "bun_repository")

def _bun_extension_impl(module_ctx):
    version = DEFAULT_BUN_VERSION
    for mod in module_ctx.modules:
        for tag in mod.tags.toolchain:
            if tag.version:
                version = tag.version
    bun_repository(name = "bun", version = version)

_toolchain_tag = tag_class(attrs = {
    "version": attr.string(default = DEFAULT_BUN_VERSION),
})

bun = module_extension(
    implementation = _bun_extension_impl,
    tag_classes = {"toolchain": _toolchain_tag},
)

def _bun_deps_extension_impl(module_ctx):
    for mod in module_ctx.modules:
        for tag in mod.tags.install:
            bun_install(
                name = tag.name,
                bun_version = tag.bun_version,
                bunfig = tag.bunfig,
                ignore_scripts = tag.ignore_scripts,
                install_flags = tag.install_flags,
                lock = tag.lock,
                package_json = tag.package_json,
                trusted_dependencies = tag.trusted_dependencies,
                workspace_files = tag.workspace_files,
            )

_install_tag = tag_class(attrs = {
    "bun_version": attr.string(default = ""),
    "bunfig": attr.label(allow_single_file = True),
    "ignore_scripts": attr.bool(default = True),
    "install_flags": attr.string_list(default = []),
    "lock": attr.label(allow_single_file = True, mandatory = True),
    "name": attr.string(mandatory = True),
    "package_json": attr.label(allow_single_file = True, mandatory = True),
    "trusted_dependencies": attr.string_list(default = []),
    "workspace_files": attr.label_list(allow_files = True, default = []),
})

bun_deps = module_extension(
    implementation = _bun_deps_extension_impl,
    tag_classes = {"install": _install_tag},
)
