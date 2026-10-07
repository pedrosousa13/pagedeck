export const VIEW_TRANSITION_STYLE =
  "<style>@view-transition { navigation: auto; }</style>";

export function viewTransitionsFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value === "boolean") return undefined;
  return `${where}: "build.viewTransitions" must be true or false — viewTransitions: true`;
}
