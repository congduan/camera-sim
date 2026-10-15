// The sources import each other without file extensions, the way a bundler
// resolves them, which Node's ESM resolver refuses. This loader puts the
// extension back so the pure modules can be tested in plain Node - no bundler,
// no browser, no shader compiler.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js')) return next(`${specifier}.js`, context);
    throw error;
  }
}
