/**
 * The branch selector (§3.3): a plain `.ui.dropdown` whose menu lists the
 * repository's branches and tags — Fomantic (in the official bundle)
 * enhances generic `.ui.dropdown` DOM, so no `data-global-init` is emitted
 * (§2.4.1: only the repo switcher uses initRepoSwitcher, and there is no
 * repo switcher without session chrome). No fuzzy jump input (§3.3).
 */


import type { RefType } from "../index";
import { commitsLink, treeLink } from "../links";

/** The ref universe one selector renders (listRefs output, resolved). */
export interface SelectorRefs {
  branches: readonly string[];
  tags: readonly string[];
}

export function BranchSelector(props: {
  repoLink: string;
  /** The family the items navigate within: `/src` tree links or `/commits`
   *  history links (both carry the `{refType}/{ref}` suffix, §2.1). */
  family: "src" | "commits";
  refs: SelectorRefs;
  /** The active ref's URL type + name (highlighted; omitted on the empty
   *  repo page where there is nothing to select). */
  active?: { refType: RefType; ref: string };
  /** Tree path preserved across ref switches (file view). */
  treePath?: string;
}) {
  const treePath = props.treePath ?? "";
  const item = (refType: RefType, name: string) => {
    const href =
      props.family === "src"
        ? treeLink(props.repoLink, refType, name, treePath)
        : commitsLink(props.repoLink, refType, name, treePath);
    const isActive = props.active !== undefined && props.active.refType === refType && props.active.ref === name;
    return (
      <a class={isActive ? "active item" : "item"} href={href}>
        {name}
      </a>
    );
  };
  return (
    <div class="ui dropdown">
      <span class="text">{props.active !== undefined ? props.active.ref : "Branches"}</span>
      <div class="menu">
        {props.refs.branches.map((name) => item("branch", name))}
        {props.refs.tags.map((name) => item("tag", name))}
      </div>
    </div>
  );
}
