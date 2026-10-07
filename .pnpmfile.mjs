// The workspace reads `source` and installs devDependencies; a consumer can do
// neither, because the tarball holds no `src` and a devDependency may name a
// private package (#690).
function withoutSource(target) {
  if (typeof target !== "object" || target === null) return target;
  return Object.fromEntries(
    Object.entries(target)
      .filter(([condition]) => condition !== "source")
      .map(([condition, inner]) => [condition, withoutSource(inner)]),
  );
}

export const hooks = {
  beforePacking(manifest) {
    const { devDependencies: _, ...packed } = manifest;
    if (packed.exports !== undefined) packed.exports = withoutSource(packed.exports);
    return packed;
  },
};
