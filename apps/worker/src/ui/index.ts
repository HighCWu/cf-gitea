/**
 * The Tier-2 UI router (SPEC-0008 §2.4 module layout): `uiRouter` +
 * `handlesUiRoute` + the route parsers (ref-suffix resolution). This module
 * is the single owner of UI route knowledge (§2.2).
 *
 * UI route inventory (§2.1 + the wave-2 extension — all GET; the slice-1
 * families render through the shell, /tree is upstream's redirect):
 *
 *   /:owner/:repo                          repo home (pages/home.tsx)
 *   /:owner/:repo/commits[/{ref-suffix}]   commit log (pages/commits.tsx)
 *   /:owner/:repo/src[/{ref-suffix}]       file view (pages/file-view.tsx;
 *                                          §3.3 requires the
 *                                          `branch|tag|commit` prefix)
 *   /:owner/:repo/tree[/{raw-suffix}]      code-tree URL family
 *                                          (pages/repo-home.tsx — upstream
 *                                          RedirectRepoTreeToSrc: 303 onto
 *                                          /src/{raw-suffix}, query kept)
 *   /:owner/:repo/issues                   issues list (pages/issues-list.tsx)
 *   /:owner/:repo/pulls                    pulls list (same component over
 *                                          is_pull rows — issues-list.tsx)
 *   /:owner/:repo/issues/{index}           issue detail (pages/issue-detail.tsx)
 *   /:owner/:repo/pulls/{index}            PR detail (same component over
 *                                          is_pull rows — issue-detail.tsx;
 *                                          upstream's type/URL match 303s the
 *                                          mismatched family onto the right
 *                                          one, issue_view.go:347-352)
 *   /:owner/:repo/issues/new               new-issue form, GET + POST
 *                                          (pages/new-issue.tsx — the first
 *                                          authed write surface; POST → the
 *                                          tier-1 IssuesService.createIssue →
 *                                          303 onto the created detail page;
 *                                          anonymous GET 303s onto
 *                                          /login?redirect_to=…)
 *   /:owner/:repo/settings                 repo basics form, GET + POST
 *                                          (pages/settings.tsx — admin
 *                                          viewer only)
 *   /:owner/:repo/settings/hooks           webhooks list + add form, GET +
 *                                          POST (pages/settings.tsx — admin
 *                                          viewer only)
 *   /:owner/:repo/{issues|pulls}/{index}/comments   comment write, POST
 *                                          (pages/issue-detail.tsx — wave 5;
 *                                          the `status` field carries the
 *                                          close/reopen toggle; success
 *                                          303s onto the canonical page
 *                                          with the #issuecomment anchor;
 *                                          anonymous 303s onto /login;
 *                                          GET → 405, upstream chi parity)
 *   /:owner/:repo/issues/labels            sidebar label write, POST
 *                                          (pages/issue-detail.tsx — wave 5;
 *                                          admin viewer only; GET → 405)
 *   /:owner/:repo/pulls/{index}/files      PR files diff view, GET
 *                                          (pages/pull-files.tsx — wave 5;
 *                                          the landed pullRequestDiff
 *                                          service)
 *   /:owner/:repo/pulls/{index}/commits    PR commits tab, GET (pages/
 *                                          pull-commits.tsx — the three-tab
 *                                          menu completion; the landed
 *                                          listCommitsRange over the PR's
 *                                          merge base and refs/pull head)
 *   /:owner/:repo/milestones               milestones list, GET (pages/
 *                                          milestones.tsx — wave 6; the
 *                                          landed listRepoMilestones read;
 *                                          `?state=` the open/closed facet)
 *   /:owner/:repo/milestones/new           new-milestone form, GET + POST
 *                                          (pages/milestones.tsx — wave 6;
 *                                          admin viewer only; POST → the
 *                                          landed milestone-create service
 *                                          → 303 back onto the list)
 *   /{org}                                 owner home — org rows: org home, GET
 *   /{user}                                owner home — user rows: user
 *                                          profile, GET (the SINGLE-SEGMENT
 *                                          family; wave 6 landed the org
 *                                          half — pages/org-home.tsx — and
 *                                          wave 7 the user half — pages/
 *                                          user-profile.tsx; one parse
 *                                          family `owner-home`, upstream's
 *                                          OwnerProfile dispatch
 *                                          routers/web/user/profile.go:37)
 *   /:owner/:repo/new/{branch}[/{dir}]     web file editor, GET + POST
 *   /:owner/:repo/edit/{branch}/{path}     (pages/file-editor.tsx — wave 8;
 *   /:owner/:repo/delete/{branch}/{path}   upstream's _new/_edit/_delete
 *                                          editor Combos under
 *                                          RepoRefByType(branch),
 *                                          web.go:1453-1461, at the brief's
 *                                          literal names; POST → the landed
 *                                          applyFileChanges with the
 *                                          session viewer as author/committer
 *                                          and the push-webhook family
 *                                          riding the delta; success 303s
 *                                          onto the file view / tree;
 *                                          anonymous GET+POST 303 onto
 *                                          /login, non-writers and archived
 *                                          repos 404-shell)
 *   /                                      site root — dashboard (signed in)
 *                                          or landing (anonymous), GET
 *                                          (pages/dashboard.tsx — wave 9;
 *                                          upstream Home,
 *                                          routers/web/home.go:26-44)
 *   /explore                               303 onto /explore/repos (wave 9)
 *   /explore/repos                         repo search page, GET
 *   /explore/users                         user search page, GET
 *                                          (pages/explore.tsx — wave 9;
 *                                          upstream web.go:549-556; the
 *                                          landed search services via
 *                                          api/services/search.ts; the
 *                                          navbar Explore item anchors the
 *                                          repos page for both viewer
 *                                          kinds)
 *   /notifications                         notifications mailbox, GET
 *                                          (pages/notifications.tsx —
 *                                          wave 10; upstream web.go:1784-
 *                                          1791's reqSignIn group —
 *                                          anonymous 303s onto /login;
 *                                          `?div-only=1` answers the bare
 *                                          #notification_div fragment the
 *                                          official bundle's live refresh
 *                                          fetches)
 *   /notifications/new                     unread-count JSON, GET (`{new:
 *                                          N}` — upstream NewAvailable,
 *                                          notification.go:433-446; the
 *                                          navbar bell's live-count hook)
 *   /notifications/status                  per-row mark read/unread/pin,
 *                                          POST (upstream
 *                                          NotificationStatusPost — the
 *                                          answer is the fresh div
 *                                          fragment the bundle morphs in;
 *                                          GET → 405)
 *   /notifications/purge                   mark-all-read, POST (upstream
 *                                          NotificationPurgePost — the
 *                                          JSONRedirect shape; GET → 405)
 *   /:owner/:repo/settings/mirror          mirror panel, GET + POST
 *                                          (pages/settings.tsx — wave 10;
 *                                          admin viewer only; the Synchronize
 *                                          Now POST enqueues the landed
 *                                          mirror-sync message)
 *   /:owner/:repo/settings/hooks/{id}      per-hook page, GET (pages/
 *                                          settings.tsx — wave 14; the edit
 *                                          form + the recent-deliveries
 *                                          list; admin viewer only)
 *   /:owner/:repo/settings/hooks/{id}[/test|/delete]
 *                                          the per-hook writes, POST (the
 *                                          edit rides the page URL —
 *                                          upstream type-prefixes it; test
 *                                          mirrors TestWebhook's literal
 *                                          tail; delete carries the id on
 *                                          the tail — upstream's shared
 *                                          /delete?id= target exists for
 *                                          the list trash buttons this UI
 *                                          does not render)
 *   /:owner/:repo/settings/branches       protected-branches rules list,
 *                                          GET (pages/branch-protection.tsx
 *                                          — wave 15; admin viewer only)
 *   /:owner/:repo/settings/branches/edit  the create/edit rule form, GET +
 *                                          POST (upstream's literal; the
 *                                          GET keyed by `?rule_name=` —
 *                                          unknown falls back to create —
 *                                          the POST by the hidden rule_id)
 *   /:owner/:repo/settings/branches/priority
 *                                          the reorder write, POST (the
 *                                          no-JS repeated-ids form of the
 *                                          landed priority op)
 *   /:owner/:repo/settings/branches/{id}/delete
 *                                          the rule delete write, POST
 *                                          (upstream's literal shape)
 *   /:owner/:repo/branches                the repo branches list, GET
 *                                          (pages/branches.tsx — wave 16;
 *                                          anonymous-capable; the DEFAULT
 *                                          badge + the SPEC-0013 §3.6
 *                                          protection badge's first
 *                                          consumer; `?q=` filter,
 *                                          `?page=` pager)
 *   /:owner/:repo/branches/delete         the branch delete write, POST
 *                                          (upstream's literal route —
 *                                          web.go:1481 DeleteBranchPost —
 *                                          re-playing the landed API
 *                                          DELETE arm + the M2 deletion
 *                                          predicate; the refusals flash
 *                                          upstream's exact texts)
 *   /{org}/labels                          org labels management, GET
 *                                          (pages/org-labels.tsx — wave 14;
 *                                          the landed org-label family's
 *                                          list over the org-teams owner
 *                                          gate; the brief's literal URL —
 *                                          upstream nests the page under
 *                                          /org/{org}/settings/labels, the
 *                                          documented divergence; claims
 *                                          the `labels` second segment
 *                                          before the repo parse, shadowing
 *                                          a repo named "labels" exactly
 *                                          like the teams literal)
 *   /{org}/labels/{new|edit|delete}        the label writes, POST (upstream's
 *                                          exact POST segments, org.NewLabel
 *                                          /UpdateLabel/DeleteLabel; GET →
 *                                          405)
 *   /:owner/:repo/commit/{sha}             commit view, GET (pages/
 *                                          commit-view.tsx — wave 18; the
 *                                          parity survey's #1 dead-end:
 *                                          upstream web.go:1739's literal
 *                                          `{sha}` route, the target of
 *                                          every ShortSha link; full oids
 *                                          resolve — the engine's
 *                                          reachable-full-oid rule — the
 *                                          7..64 prefix shapes 404-shell,
 *                                          the documented divergence)
 *   /:owner/:repo/releases                 releases list, GET (pages/
 *                                          releases.tsx — wave 20; the
 *                                          parity survey's #4, upstream
 *                                          web.go:1506 repo.Releases over
 *                                          the landed api/services/releases
 *                                          + release-assets reads; drafts
 *                                          ride the write grant)
 *   /:owner/:repo/releases/new             new-release form, GET + POST
 *                                          (pages/releases.tsx — wave 20;
 *                                          upstream web.go:1517-1518; the
 *                                          writer gate; POST → the landed
 *                                          IssuesService.createRelease +
 *                                          the `release` webhook → 303 onto
 *                                          the created detail page)
 *   /:owner/:repo/releases/latest          303 onto the latest stable
 *                                          release's detail (upstream
 *                                          web.go:1510 LatestRelease —
 *                                          Redirect(Link()))
 *   /:owner/:repo/releases/tag/{tag}       release detail, GET (pages/
 *                                          releases.tsx — wave 20; upstream
 *                                          web.go:1509 SingleRelease — the
 *                                          SAME list template over one
 *                                          row; the decoded tail keeps
 *                                          slashes, the API family's
 *                                          html_url shape re-parses)
 *   /:owner/:repo/releases/edit/{tag}      release edit form + write, GET +
 *                                          POST (pages/releases.tsx — wave
 *                                          33, the survey's top-5 #4;
 *                                          upstream web.go:1519-1520
 *                                          EditRelease/EditReleasePost —
 *                                          new.tmpl under
 *                                          PageIsEditRelease, the landed
 *                                          editRelease arm, writer-gated;
 *                                          POST 303s onto the list)
 *   /:owner/:repo/releases/delete          release delete, POST (wave 33;
 *                                          upstream web.go:1523
 *                                          DeleteRelease — the edit page's
 *                                          red button, the landed
 *                                          deleteRelease cascade + the
 *                                          `release` deleted webhook, drafts
 *                                          silent; GET → 405)
 *   /:owner/:repo/compare[/{base}...{head}]  compare view, GET + POST
 *                                          (pages/compare.tsx — wave 13;
 *                                          upstream web.go:1307-1315's
 *                                          /compare group — the bare URL and
 *                                          the FIRST-`...` split, `..` and
 *                                          fork-form heads unclaimed → the
 *                                          engine's 404; the POST is the
 *                                          new-PR write over the landed
 *                                          create arms, writer-gated, 303
 *                                          onto the created PR)
 *   /:owner/:repo/pulls/{index}/files/reviews/submit  review verdict write,
 *                                          POST (pages/pull-reviews.tsx —
 *                                          wave 11; upstream web.go:1678
 *                                          SubmitReview; success 303s onto
 *                                          the PR page's #issuecomment
 *                                          anchor; anonymous 303s onto
 *                                          /login; GET → 405)
 *   /:owner/:repo/issues/request_review     review request add/detach, POST
 *                                          (pages/pull-reviews.tsx — wave
 *                                          11; upstream web.go:1435
 *                                          UpdatePullReviewRequest; the
 *                                          issue/reviewer ids ride the
 *                                          form; GET → 405)
 *   /:owner/:repo/issues/dismiss_review     review dismiss, POST
 *                                          (pages/pull-reviews.tsx —
 *                                          wave 11; upstream web.go:1436
 *                                          DismissReview, admin only;
 *                                          GET → 405)
 *   /:org/teams                             org teams list, GET (pages/
 *                                          org-teams.tsx — wave 12;
 *                                          upstream web.go:993 org.Teams
 *                                          at the landed requireOrgOwnership
 *                                          posture — owner/site-admin
 *                                          viewers only, everyone else
 *                                          404-shells; the literal claims
 *                                          the shape before the repo parse,
 *                                          upstream's own shadowing order)
 *   /:org/teams/new                         create-team form, GET + POST
 *                                          (pages/org-teams.tsx — wave 12;
 *                                          upstream teams.go:316-390
 *                                          NewTeam/NewTeamPost at the
 *                                          owner gate; POST → the landed
 *                                          createTeam arm → 303 onto the
 *                                          created team's detail slice)
 *   /:org/teams/{id}                        team detail slice, GET (pages/
 *                                          org-teams.tsx — wave 12; the
 *                                          members + repo-access lists,
 *                                          upstream members.tmpl +
 *                                          repositories.tmpl merged; the id
 *                                          keys the landed /teams/{id} read
 *                                          arms — upstream's name links are
 *                                          the documented divergence)
 *   /user/settings                          user settings profile, GET + POST
 *                                          (pages/user-settings.tsx — wave
 *                                          12; upstream's reqSignIn
 *                                          /user/settings group at the
 *                                          settingsGate posture — anonymous
 *                                          303s onto /login; POST re-plays
 *                                          the landed PATCH route's service
 *                                          sequence → 303)
 *   /repo/create                            new-repository form, GET + POST
 *                                          (pages/repo-create.tsx — wave
 *                                          19; upstream's reqSignIn
 *                                          /repo/create group,
 *                                          web.go:1094-1098; POST → the
 *                                          landed create arms —
 *                                          createUserRepository for the
 *                                          doer, requireCanCreateOrgRepo +
 *                                          RepoService.create for an org —
 *                                          303 onto the new repo's home;
 *                                          anonymous 303s onto /login)
 *   /org/create                             new-organization form, GET +
 *                                          POST (pages/org-create.tsx —
 *                                          wave 19; upstream's reqSignIn
 *                                          /org/create group, web.go:970-
 *                                          974; POST → the landed
 *                                          OrgService.createOrg → 303 onto
 *                                          the org home)
 *   /org/{org}/members                      org members list, GET (pages/
 *                                          org-members.tsx — wave 23;
 *                                          upstream's literal web.go:965;
 *                                          anonymous-capable — the
 *                                          FindOrgMembersOpts.PublicOnly
 *                                          scope is the per-row gate; the
 *                                          landed orgListMembers read)
 *   /{org}/-/repositories                   org repositories view, GET
 *                                          (pages/org-repos.tsx — wave 23;
 *                                          upstream's web.go:1134 route in
 *                                          the /{username}/- group; the
 *                                          org-home DOM through the second
 *                                          URL — tplOrgHome serves both
 *                                          upstream; user names 404-shell)
 *   /:owner/:repo/forks                    forks list, GET (pages/
 *                                          repo-social.tsx — wave 24; the
 *                                          parity survey's bench trio,
 *                                          web.go:1759; the landed
 *                                          listForks read with the reduced
 *                                          accessible-condition)
 *   /:owner/:repo/stars                    stargazers cards, GET (same
 *                                          module — web.go:1766; the
 *                                          landed listRepoStargazers read;
 *                                          upstream's tplWatchers serves
 *                                          both social pages, so this
 *                                          carries `repository watchers`)
 *   /:owner/:repo/watchers                 watchers cards, GET (same
 *                                          module — web.go:1767; the
 *                                          landed listRepoSubscribers
 *                                          read)
 *   /:owner/:repo/settings/collaboration   collaborators + teams settings
 *                                          panel, GET + POST (pages/
 *                                          settings-collaboration.tsx —
 *                                          wave 24; upstream web.go:1194's
 *                                          group; the POSTs are the add
 *                                          collaborator write plus the
 *                                          literal /access_mode, /delete,
 *                                          /team and /team/delete write
 *                                          tails over the landed
 *                                          repo-collaborators +
 *                                          TeamsService arms; admin viewer
 *                                          only — the settingsGate)
 *   /:owner/:repo/tags                     tags list page, GET (pages/tags.tsx
 *                                          — wave 25; the parity survey's
 *                                          TOP-1 row, upstream web.go:1493-
 *                                          1496's literal; the ENGINE ref
 *                                          universe (the repoListTags API's
 *                                          read) with the header menu's
 *                                          Releases/Tags pair and the per-
 *                                          tag Detail/New-Release links;
 *                                          anonymous-capable; empty repos
 *                                          404 (the group's MustBeNotEmpty);
 *                                          `?q=` filter, `?page=` pager)
 *   /:owner/:repo/tags/list                tags aux JSON, GET (pages/
 *                                          tag-list-aux.ts — wave 33, the
 *                                          survey's top-5 #2 tail; upstream
 *                                          web.go:1499 GetTagList — the
 *                                          branchTagSearchResponse shape
 *                                          {"results":[names]}, no filter,
 *                                          no query; the pin carries no
 *                                          fetching consumer, shape parity)
 *   /:owner/:repo/tags/delete              tag delete, POST (wave 33; the
 *                                          survey's top-5 #2 tail, upstream
 *                                          web.go:1501 DeleteTag — the tags
 *                                          page's per-row control,
 *                                          code-writer-gated over the
 *                                          engine ref universe + the D1
 *                                          tag-record drop, the 409
 *                                          release-attached class; GET →
 *                                          405)
 *   /:owner/:repo/labels                   labels management page, GET (pages/
 *                                          repo-labels.tsx — wave 25; the
 *                                          survey's TOP-2 row, upstream
 *                                          web.go:1338's reader group —
 *                                          anonymous-capable; the repo-label
 *                                          family's list + the upstream
 *                                          `.OrgLabels` org section)
 *   /:owner/:repo/labels/{new|edit|delete} the label writes, POST (upstream's
 *                                          exact POST segments, web.go:
 *                                          1417-1422 — repo.NewLabel/
 *                                          UpdateLabel/DeleteLabel over the
 *                                          landed repo-label arms; the
 *                                          writer gate: anonymous 303s onto
 *                                          login, archived/non-writer 404-
 *                                          shells; GET → 405;
 *                                          /labels/initialize stays
 *                                          unclaimed — no template catalog)
 *   /:owner/:repo/milestone/{id}          milestone detail, GET (pages/
 *                                          milestone-detail.tsx — wave 26;
 *                                          the survey's TOP-3 row, upstream
 *                                          web.go:1340's SINGULAR literal;
 *                                          the milestone's issues+pulls list
 *                                          with the open/closed tabs and the
 *                                          writer's Edit button; anonymous-
 *                                          capable; unknown/foreign ids 404)
 *   /:owner/:repo/milestones/{id}/edit    milestone edit form, GET + POST
 *                                          (pages/milestone-detail.tsx —
 *                                          web.go:1427-1428's writer combo;
 *                                          the labels-write gate; POST → the
 *                                          landed editRepoMilestone → 303
 *                                          onto the list; the close/open +
 *                                          delete write tails stay
 *                                          unclaimed)
 *   /:owner/:repo/fork                    fork-create form, GET + POST
 *                                          (pages/repo-fork.tsx — wave 26;
 *                                          the survey's TOP-5 row, upstream
 *                                          web.go:1490's combo; the owner
 *                                          select over the doer + the
 *                                          can-create orgs, POST → the
 *                                          landed createFork sequence →
 *                                          303 onto the fork's home;
 *                                          anonymous 303s onto /login, an
 *                                          empty source 404s)
 *   /:owner/:repo/commit/{sha}.{diff|patch}
 *   /:owner/:repo/pulls/{index}.{diff|patch}
 *                                          the diffpatch file downloads,
 *                                          GET (pages/diffpatch-files.ts —
 *                                          wave 29; the survey's row 4,
 *                                          upstream web.go:1760 repo.RawDiff
 *                                          + web.go:1657-1658
 *                                          DownloadPullDiff/Patch — raw
 *                                          text, not pages: the plain
 *                                          unified diff or the git-am mail
 *                                          shape over the landed
 *                                          renderUnifiedDiff/renderPatch +
 *                                          engineReads.readDiff /
 *                                          pullRequestDiff; short-sha
 *                                          prefixes 404 per the engine's
 *                                          full-oid rule, the commit-view
 *                                          divergence)
 *   /:owner/:repo/archive[/*]              the archive download, GET
 *                                          (pages/archive-files.ts — wave
 *                                          32; the survey's row 1, upstream
 *                                          web.go:1689 repo.Download over
 *                                          services/repository/archiver —
 *                                          the {ref}.{zip|tar.gz} tail
 *                                          streams the landed
 *                                          api/services/archive.ts builder;
 *                                          octet-stream + nosniff, the
 *                                          weak ETag/304 pair, the Nix
 *                                          immutable Link header; unknown
 *                                          suffix and the bundle refusal
 *                                          answer upstream's 400 class, the
 *                                          bare `/archive` tail included;
 *                                          the POST half —
 *                                          InitiateDownload, web.go:1690 —
 *                                          stays engine-owned)
 *   /:owner/:repo/commit/{sha}/load-branches-and-tags
 *                                          the commit view's aux JSON, GET
 *                                          (pages/commit-contained-refs.ts —
 *                                          wave 32; the survey's row 3,
 *                                          upstream web.go:1740
 *                                          repo.LoadBranchesAndTags — the
 *                                          ContainedLinks shape
 *                                          {branches,tags,default_branch}
 *                                          with per-ref {name,web_link}
 *                                          over the engine's listRefs +
 *                                          mergeBase containment walk (the
 *                                          module doc carries the cost
 *                                          posture); short/unresolvable
 *                                          shas 404 — upstream's
 *                                          ServerError 500 divergence)
 *   /:owner/:repo/blob[/*]                 the pasted-blob-URL redirect, GET
 *                                          (pages/repo-home.tsx's
 *                                          blobRedirectResponse — wave 39;
 *                                          the survey's row 1, upstream
 *                                          web.go:1757
 *                                          repo.RedirectRepoBlobToCommit —
 *                                          the tree-redirect twin: the RAW
 *                                          suffix swaps verbatim onto
 *                                          `/src/commit/`, query preserved,
 *                                          303 See Other; the bare `/blob`
 *                                          has no upstream route → the
 *                                          §4.5 404 shell)
 *   /:owner/:repo/tree-list/{branch|tag|commit}/*
 *                                          the find-file dialog's aux JSON,
 *                                          GET (pages/tree-list-aux.ts —
 *                                          wave 39; the survey's row 5,
 *                                          upstream web.go:1297-1306
 *                                          repo.TreeList — the bare
 *                                          recursive file-path array over a
 *                                          batched listTree BFS walk, the
 *                                          natural-sort port; the typed
 *                                          ref-tail resolution rides the
 *                                          landed resolveRefSuffix)
 *   /:owner/:repo/tree-view/{branch|tag|commit}/*
 *                                          the code-tree envelope aux JSON,
 *                                          GET (pages/tree-view-aux.ts —
 *                                          wave 43; the survey's row 5
 *                                          PARTIAL row's gated half,
 *                                          upstream web.go:1302-1306
 *                                          repo.TreeViewNodes — the
 *                                          {fileTreeNodes, renderedIconPool}
 *                                          envelope over the landed fileicon
 *                                          layer, the Go-escape wire bytes;
 *                                          the tail's path half roots the
 *                                          listing, ?sub_path= names the
 *                                          expansion chain)
 *   /:owner/:repo/branches/list            the branches aux JSON, GET
 *                                          (pages/branches-list-aux.ts —
 *                                          wave 39; the survey's row 5,
 *                                          upstream web.go:1695
 *                                          repo.GetBranchesList — the
 *                                          {results:[names]} feed, default
 *                                          branch hoisted, the tag-list-aux
 *                                          twin)
 *   /:owner/:repo/blob_excerpt/{sha}       the PR-diff hunk-window expansion
 *                                          fragment, GET (pages/repo-blob
 *                                          -excerpt-fragment.tsx — wave 46,
 *                                          the machinery's stage 3; upstream
 *                                          web.go:1735 repo.ExcerptBlob —
 *                                          the tplBlobExcerpt `<tr>` rows
 *                                          over BuildBlobExcerptDiffSection,
 *                                          the RenderBlobExcerptButtons
 *                                          round-trip; the wiki twin below)
 *   /:owner/:repo/wiki/blob_excerpt/{sha}  the excerpt's wiki-cell twin, GET
 *                                          (web.go:1618 — the same builder
 *                                          over the sibling `slug.wiki`
 *                                          engine cell, the hasWiki gate,
 *                                          BaseLink swapped)
 *   /:owner/:repo/lastcommit/*             the file-list commit-info refresh
 *                                          fragment, GET (pages/repo-lastcommit
 *                                          -fragment.tsx — wave 46 mounts
 *                                          the machinery wave's handoff;
 *                                          upstream web.go:1761
 *                                          repo.LastCommit — the
 *                                          tplRepoViewList standalone
 *                                          fragment the view_list loader
 *                                          fetches)
 *   /:owner/:repo/releases/attachments/{uuid}
 *   /:owner/:repo/releases/download/{vTag}/{fileName}
 *                                          the releases download tail, GET
 *                                          (pages/release-downloads.ts —
 *                                          wave 41; the survey's top-5 #1,
 *                                          upstream web.go:1513
 *                                          repo.GetAttachment + web.go:1514
 *                                          repo.RedirectDownload — the
 *                                          streamed asset serve over the
 *                                          landed release-assets data, the
 *                                          ServeAttachment header matrix +
 *                                          the `latest` alias; the module
 *                                          doc carries the ledger)
 *   /:owner/:repo/render/{branch|tag|commit}/*
 *   /:owner/:repo/render/blob/{sha}        the rendered blob views, GET
 *                                          (pages/render-files.ts — wave
 *                                          41; the survey's row 3,
 *                                          upstream web.go:1715-1719's
 *                                          /render group — standalone-page
 *                                          renders over the landed
 *                                          markdown pipeline, the
 *                                          "Unable to find renderer" 400
 *                                          class elsewhere; the module doc
 *                                          carries the divergences)
 *   /{org}/settings[/{avatar|rename|delete|visibility|avatar/delete}]
 *                                          the org settings page + its
 *                                          write arms, GET + POST on the
 *                                          bare URL, POST elsewhere
 *                                          (pages/org-settings.tsx — wave
 *                                          49; the survey's re-ranked #1,
 *                                          upstream web.go:1017-1092's
 *                                          require-owner /{org} group over
 *                                          org/settings/options.tmpl — the
 *                                          landed orgEdit/renameOrg/
 *                                          orgDelete/avatar ops; the
 *                                          applications/labels/packages/
 *                                          actions/blocked_users/audit_logs
 *                                          TABS are separate pages this
 *                                          wave does not claim; the
 *                                          `settings` literal shadows a
 *                                          repository so named exactly
 *                                          like upstream's group order)
 *   /{org}/settings/hooks                  the org webhooks list + add form,
 *                                          GET + POST
 *   /{org}/settings/hooks/{id}             the org per-hook page, GET + POST
 *   /{org}/settings/hooks/{id}/delete      the org hook delete, POST
 *                                          (pages/org-settings-hooks.tsx —
 *                                          wave 53; upstream web.go:1033-1044's
 *                                          /hooks group over org/settings/
 *                                          {hooks,hook_new}.tmpl — the
 *                                          landed owner-scoped hook arms
 *                                          (listOwnerHooks/createOwnerHook/
 *                                          getOwnerHook/deleteOwnerHook +
 *                                          the scope-agnostic editRepoHook,
 *                                          routes/hooks-scopes.ts's org
 *                                          family); no test/replay arms —
 *                                          the module header's reductions;
 *                                          the same require-owner posture)
 *   /{org}/teams/{id}/edit                 the team edit form, GET + POST
 *   /{org}/teams/{id}/delete               the team delete, POST
 *                                          (same module — web.go:1011-1013
 *                                          over the landed orgEditTeam/
 *                                          orgDeleteTeam arms; the entry
 *                                          link is the team detail
 *                                          sidebar's Settings button)
 *
 * The wave-2 families dispatch INSIDE this router (uiPage); render.tsx's
 * page switch stays the slice-1 three — which is why they parse into the
 * separate TreeRoute/IssuesListRoute/IssueDetailRoute types below instead of
 * new UiFamily members. The wave-4 write families (issue-new/settings/
 * settings-hooks) dispatch here too, with their own GET+POST handlers.
 * The rest of the suffixed /issues//pulls space (`/issues/{index}/comments`,
 * non-numeric or deeper tails), the rest of the deeper /settings/* space
 * (wave 15 claimed `/settings/branches` + its `/edit`, `/priority` and
 * `/{id}/delete` writes — pages/branch-protection.tsx; keys/tags/LFS and
 * friends stay engine-owned), and every other repo-scoped path stay with the
 * engine — the four git-protocol routes, the LFS family, and the engine
 * JSON API/admin surface. The parser claims families by shape and never
 * protocol or engine paths, and the reserved owner names (`api`, `assets` —
 * SPEC-0003 §3) are refused outright, so `/api/v1` and the edge-served
 * `/assets/*` tree are out of reach by construction.
 *
 * ## Dispatcher integration (orchestrator-owned `src/index.ts`, §2.2)
 *
 * Branch order: api → ui (`handlesUiRoute`) → gitHttpGate → engine. Exact
 * insertion:
 *
 * ```ts
 * import { uiRouter, handlesUiRoute } from "./ui";
 *
 * const app = new Hono<{ Bindings: Env }>();
 * // ... the existing /healthz + /api/v1 registrations stay first ...
 * app.route("/", uiRouter); // uiRouter claims only handlesUiRoute families
 *
 * // inside `fetch`, replacing the current unconditional repo-scoped branch
 * // (`segments[0] !== "api"` already keeps /api/v1 in Hono-land):
 * if (isRepoScoped) {
 *   // UI page families — src/ui is the single source of truth:
 *   if (handlesUiRoute(pathname)) return app.fetch(req, env, ctx);
 *   // git-protocol routes + engine passthrough: unchanged.
 *   return gitHttpGate(req, env, ctx, gitHttp);
 * }
 * return app.fetch(req, env, ctx);
 * ```
 *
 * `handlesUiRoute` is consulted BEFORE Hono is asked to route (§2.2), so the
 * sub-app only ever sees families it claims and its miss path can never
 * swallow an engine route.
 *
 * U3 note: the three pages render for real (home / commits / src, wired in
 * render.tsx's page switch). Every claimed route answers from the same
 * pipeline: parse → public-repo read (§2.5) → page data via direct service
 * calls (§3.2) → shell render; anything unresolved 404-shells. The parsers
 * below (`parseUiRoute`, `splitRefSuffix`, `resolveRefSuffix`) are the
 * pages' URL contract and ship with their semantics tests.
 */

import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { trimTrailingSlash } from "hono/trailing-slash";

import { isReservedOwnerName } from "../repos/service";
import { users } from "../db/schema";
import { engineClient } from "./engine";
import { readUrlEncodedForm } from "./forms";
import { AssetBuildError, loadManifest } from "./manifest";
import { parsePageNumber, pathEscapeSegments } from "./page-data";
import { resolveRepositoryForViewer } from "./repo-view";
import { renderNotFound, renderUiPage } from "./render";
import { sameOriginGuard } from "./session";
import { blobRedirectResponse, isFetchActionRequest, treeRedirectResponse } from "./pages/repo-home";
import {
  loadReleaseDownload,
  openReleaseAttachment,
  releaseAttachmentResponse,
  type ReleaseAttachmentServe,
} from "./pages/release-downloads";
import { loadRenderFile, renderFileResponse, renderNotAvailableResponse, type RenderFileTarget } from "./pages/render-files";
import {
  canWriteRepo,
  commitFileFromForm,
  editorFormFromData,
  loadFileEditorData,
  readEditorForm,
  renderFileEditorPage,
} from "./pages/file-editor";
import {
  applyIssueLabels,
  createCommentFromForm,
  crossFamilyRedirect,
  loadIssueDetailData,
  parseCommentForm,
  parseIssueLabelForm,
  renderIssueDetailPage,
  resolveIssueDetailAccess,
} from "./pages/issue-detail";
import {
  changeReviewRequestFromForm,
  dismissReviewFromForm,
  parseDismissReviewForm,
  parseReviewRequestForm,
  parseReviewSubmitForm,
  PullReviewError,
  pullReviewErrorMessage,
  submitReviewFromForm,
} from "./pages/pull-reviews";
import {
  countUnreadNotifications,
  loadNotificationsData,
  markNotificationThread,
  parseFormBool,
  parseNotificationPageType,
  parseNotificationStatusForm,
  purgeNotifications,
  renderNotificationDiv,
  renderNotificationsPage,
} from "./pages/notifications";
import { loadIssuesListData, renderIssuesListPage } from "./pages/issues-list";
import {
  createMilestoneFromForm,
  loadMilestonesData,
  milestonesLocale,
  parseMilestoneForm,
  renderMilestonesPage,
  renderNewMilestonePage,
} from "./pages/milestones";
import { loadOrgHomeData, renderOrgHomePage, resolveOrgHome } from "./pages/org-home";
import {
  canManageOrgTeams,
  createTeamFromForm,
  loadOrgTeamDetailData,
  loadOrgTeamsData,
  parseTeamNewForm,
  renderOrgTeamDetailPage,
  renderOrgTeamNewPage,
  renderOrgTeamsPage,
  resolveOrgTeamsOrg,
} from "./pages/org-teams";
import {
  createOrgLabelFromForm,
  deleteOrgLabelFromForm,
  editOrgLabelFromForm,
  formLabelId,
  loadOrgLabelsData,
  NEW_LABEL_DEFAULT_COLOR,
  parseOrgLabelForm,
  renderOrgLabelsPage,
} from "./pages/org-labels";
import {
  applyOrgDeleteForm,
  applyOrgRenameForm,
  applyOrgSettingsForm,
  applyOrgTeamDelete,
  applyOrgTeamEditForm,
  applyOrgVisibilityForm,
  deleteOrgAvatar,
  loadOrgTeamEditData,
  parseOrgDeleteForm,
  parseOrgRenameForm,
  parseOrgSettingsForm,
  parseOrgTeamEditForm,
  parseOrgVisibilityForm,
  readOrgAvatarUpload,
  renderOrgSettingsPage,
  renderOrgTeamEditPage,
  storeOrgAvatar,
  teamEditFormFromTeam,
} from "./pages/org-settings";
// Wave-53 org settings hooks tab (the org-settings module's named next
// slice — the landed owner-scoped hook arms under the /settings subtree).
import {
  createOrgHookFromForm,
  deleteOrgHook,
  loadOrgHookDetailData,
  loadOrgHooksSettings,
  renderOrgHookDetailPage,
  renderOrgHooksSettingsPage,
} from "./pages/org-settings-hooks";
// Window-2b: the org blocked-users tab + the actions secrets/variables
// sub-tabs (two-stage waves 55/59, mounted by this window).
import {
  applyOrgBlockedForm,
  loadOrgBlockedUsers,
  parseOrgBlockedForm,
  renderOrgBlockedUsersPage,
} from "./pages/org-settings-blocked";
import {
  applyOrgActionsSecretForm,
  applyOrgActionsVariableCreate,
  applyOrgActionsVariableUpdate,
  deleteOrgActionsSecret,
  deleteOrgActionsVariable,
  loadOrgActionsSecretsPageData,
  loadOrgActionsVariablesPageData,
  parseOrgActionsSecretDeleteForm,
  parseOrgActionsSecretForm,
  parseOrgActionsVariableForm,
  renderOrgActionsSecretsPage,
  renderOrgActionsVariablesPage,
} from "./pages/org-settings-actions";
import {
  applyUserProfileForm,
  loadUserSettingsPageData,
  parseUserProfileForm,
  renderUserSettingsPage,
} from "./pages/user-settings";
// Window-2a: the user-settings tab modules (two-stage waves 54-58, mounted
// by this window — each module's header carries its route recipe).
import {
  applyUserSettingsAppearanceLanguageForm,
  applyUserSettingsAppearanceThemeForm,
  loadUserSettingsAppearancePageData,
  parseUserSettingsAppearanceLanguageForm,
  parseUserSettingsAppearanceThemeForm,
  renderUserSettingsAppearancePage,
} from "./pages/user-settings-appearance";
import {
  loadUserSettingsSecurityPageData,
  renderUserSettingsSecurityPage,
} from "./pages/user-settings-security";
import {
  applyUserSettingsSecretForm,
  deleteUserSettingsSecret,
  loadUserSettingsSecretsPageData,
  parseUserSettingsSecretDeleteForm,
  parseUserSettingsSecretForm,
  renderUserSettingsSecretsPage,
} from "./pages/user-settings-secrets";
import {
  applyUserSettingsVariableCreate,
  applyUserSettingsVariableUpdate,
  deleteUserSettingsVariable,
  loadUserSettingsVariablesPageData,
  parseUserSettingsVariableForm,
  renderUserSettingsVariablesPage,
} from "./pages/user-settings-variables";
import {
  createUserHookFromForm,
  deleteUserHook,
  editUserHookFromForm,
  loadUserHookDetailData,
  loadUserSettingsHooksPageData,
  renderUserHookDetailPage,
  renderUserSettingsHooksPage,
} from "./pages/user-settings-webhooks";
import {
  addGpgKeyFromForm,
  addSshKeyFromForm,
  deleteGpgKey,
  deleteSshKey,
  loadUserSettingsKeysOwner,
  loadUserSettingsKeysPageData,
  parseUserSettingsKeysDeleteForm,
  parseUserSettingsKeysForm,
  renderUserSettingsKeysPage,
} from "./pages/user-settings-keys";
import {
  createTokenFromForm,
  loadUserSettingsApplicationsPageData,
  parseUserSettingsApplicationsDeleteForm,
  parseUserSettingsApplicationsForm,
  renderUserSettingsApplicationsPage,
  revokeTokenFromForm,
} from "./pages/user-settings-applications";
import {
  applyUserOrgsLeave,
  loadUserOrgsSettings,
  parseUserOrgsLeaveForm,
  renderUserOrgsSettingsPage,
} from "./pages/user-settings-organizations";
// Window-2c: the admin pages (two-stage waves 61/64, mounted by this
// window — /-/admin group, web.go:779-813).
import {
  applyAdminDashboardForm,
  loadAdminDashboardData,
  parseAdminDashboardForm,
  renderAdminDashboardPage,
} from "./pages/admin-dashboard";
import {
  applyAdminMonitorCronForm,
  loadAdminMonitorCron,
  loadAdminMonitorQueues,
  loadAdminMonitorStats,
  parseAdminMonitorCronForm,
  renderAdminMonitorCronPage,
  renderAdminMonitorQueuePage,
  renderAdminMonitorStatsPage,
  renderAdminMonitorTracePage,
} from "./pages/admin-monitor";
import type { AdminMonitorPage } from "./pages/admin-monitor";
import { loadUserProfileData, renderUserProfilePage, resolveUserProfile } from "./pages/user-profile";
// Wave-19 creation pages (the authoring front door — the survey's #2).
import {
  createRepoFromForm,
  loadRepoCreateData,
  parseRepoCreateForm,
  renderRepoCreatePage,
} from "./pages/repo-create";
import {
  createOrgFromForm,
  parseOrgCreateForm,
  renderOrgCreatePage,
} from "./pages/org-create";
// Wave-23 org families (the parity survey's next tier — the members page and
// the /-/repositories repositories family).
import {
  isOrgOwnerViewer,
  loadOrgMembersData,
  renderOrgMembersPage,
  resolveOrgMembersOrg,
} from "./pages/org-members";
import {
  loadOrgRepositoriesData,
  renderOrgRepositoriesPage,
  resolveOrgRepositories,
} from "./pages/org-repos";
// Wave-37 owner projects list family (the parity survey's regenerated
// top-5 row 5 — the `/-` namespace's projects listing over the landed
// projects service).
import {
  loadOwnerProjectsData,
  renderOwnerProjectsPage,
  resolveOwnerProjects,
} from "./pages/owner-projects";
// Wave-40 owner projects BOARD families (the survey's follow-up row — the
// board view + write group + workflow tails over the landed service
// predicates).
import {
  boardDoer,
  createColumnFromForm,
  createProjectFromForm,
  createWorkflowFromForm,
  deleteWorkflowFromForm,
  findOwnerProject,
  loadProjectBoardData,
  loadProjectChromeCounts,
  loadProjectWorkflowsData,
  ownerProjectWriteAccess,
  parseColumnForm,
  parseProjectForm,
  parseWorkflowForm,
  projectLinkOf,
  renderEditProjectPage,
  renderNewProjectPage,
  renderProjectBoardPage,
  renderProjectWorkflowsPage,
  setProjectDefaultColumnFromForm,
  updateProjectFromForm,
  updateWorkflowFromForm,
  type ResolvedOwner,
  type WorkflowForm,
  WORKFLOW_EVENTS,
} from "./pages/owner-project-board";
// Wave-45 repo projects surface (the parity survey's re-ranked #1 — the
// repo scope over the landed projects family; the owner-board precedent's
// owner-agnostic shapes imported, the owner-bound ones adapted beside the
// repo resolution + the has_projects unit toggle).
import {
  createRepoProjectFromForm,
  createRepoWorkflowFromForm,
  loadRepoProjectBoardData,
  loadRepoProjectWorkflowsData,
  loadRepoProjectsData,
  repoProjectLink,
  renderRepoProjectBoardPage,
  renderRepoProjectEditPage,
  renderRepoProjectNewPage,
  renderRepoProjectsPage,
  renderRepoProjectWorkflowsPage,
  updateRepoWorkflowFromForm,
} from "./pages/repo-projects";
import { loadRepoSettings } from "../api/services/repo-settings";
import {
  canManageOrgProjectWorkflows,
  canManageUserProjectWorkflows,
  cardTypeToString,
  changeProjectStatus,
  deleteProjectById,
  findProjectById,
  findWorkflowByIdAndProject,
  repoProjectScope,
  type ProjectRow,
} from "../api/services/projects";
// Wave-24 repo social lists + collaboration panel (the parity survey's bench
// tier — the forks/stars/watchers trio and the settings/collaboration row).
import { loadRepoSocialData, renderRepoSocialPage } from "./pages/repo-social";
import {
  addCollaboratorFromForm,
  addTeamFromForm,
  canChangeRepoTeamAccess,
  changeAccessModeFromForm,
  loadCollaborationData,
  removeCollaboratorFromForm,
  removeTeamFromForm,
  renderCollaborationPage,
} from "./pages/settings-collaboration";
// Wave-25 repo tags + labels pages (the parity survey's TOP-2 dispatchable
// rows — the tags listing over the engine ref universe and the repo labels
// management page over the landed repo-label family).
import {
  applyTagDelete,
  loadTagsData,
  parseTagDeleteForm,
  renderTagsPage,
  TAG_RELEASE_ATTACHED_MESSAGE,
} from "./pages/tags";
import { loadTagListAux, tagListResponse } from "./pages/tag-list-aux";
import {
  createRepoLabelFromForm,
  deleteRepoLabelFromForm,
  editRepoLabelFromForm,
  loadRepoLabelsData,
  parseRepoLabelForm,
  renderRepoLabelsPage,
} from "./pages/repo-labels";
// Wave-26 milestone detail + edit and the fork form (the parity survey's
// TOP-3 and TOP-5 rows — the milestone row's dead ends and the fork-create
// form over the landed createFork machinery).
import {
  editMilestoneFromForm,
  loadMilestoneDetailData,
  loadMilestoneEditData,
  milestoneEditFormOf,
  renderMilestoneDetailPage,
  renderMilestoneEditPage,
} from "./pages/milestone-detail";
import {
  createForkFromForm,
  loadRepoForkData,
  parseRepoForkForm,
  renderRepoForkPage,
} from "./pages/repo-fork";
import { loadDashboardData, renderDashboardPage, renderLandingPage } from "./pages/dashboard";
import {
  loadExploreReposData,
  loadExploreUsersData,
  renderExploreReposPage,
  renderExploreUsersPage,
} from "./pages/explore";
import {
  createIssueFromForm,
  loadNewIssueData,
  newIssueLocale,
  readNewIssueForm,
  renderNewIssuePage,
} from "./pages/new-issue";
import { loadPullFilesData, renderPullFilesPage } from "./pages/pull-files";
// Wave-29 diffpatch downloads (the survey's row 4 — the four raw-text
// .diff/.patch routes; the loaders + Response builder live in the module,
// the handlers here beside their sibling dispatchers).
import { diffPatchTextResponse, loadCommitDiffPatch, loadPullDiffPatch } from "./pages/diffpatch-files";
// Wave-32 archive download + commit aux JSON (the survey's rows 1 + 3 —
// the streamed {ref}.{zip|tar.gz} tail and the load-branches-and-tags
// ContainedLinks feed; loaders + Response builders in the modules, the
// handlers here beside their sibling dispatchers).
import {
  archiveBadFormatResponse,
  loadRepoArchive,
  repoArchiveResponse,
} from "./pages/archive-files";
import { containedRefsResponse, loadCommitContainedRefs } from "./pages/commit-contained-refs";
// Wave-39 aux fragments (the survey's row 5 — the tree-list find-file feed
// and the branches/list name feed; loaders + Response builders in the
// modules, the handlers here beside their sibling dispatchers).
import { branchesListResponse, loadBranchesListAux } from "./pages/branches-list-aux";
import { loadTreeListAux, treeListResponse } from "./pages/tree-list-aux";
// Wave-43 tree-view envelope (the survey's PARTIAL row-5 gated half — the
// fileicon-unlocked fragment; loader + Response builder in the module, the
// handler here beside its sibling dispatchers).
import { loadTreeViewNodes, treeViewResponse } from "./pages/tree-view-aux";
// Wave-46 fragment mounts (the machinery waves' routes — the row-5 skips
// landing): the lastcommit handoff's loader/builder and the blob-excerpt
// stage-3 loader/builder (pages/repo-lastcommit-fragment.tsx +
// pages/repo-blob-excerpt-fragment.tsx), the handlers here beside their
// sibling dispatchers.
import { loadLastCommitFragment, lastCommitFragmentHtml, lastCommitFragmentResponse, parseLastCommitTail } from "./pages/repo-lastcommit-fragment";
import {
  blobExcerptFragmentHtml,
  blobExcerptFragmentResponse,
  hashFilePathForWebUI,
  loadBlobExcerptSection,
  parseBlobExcerptForm,
} from "./pages/repo-blob-excerpt-fragment";
import { loadPullCommitsData, renderPullCommitsPage } from "./pages/pull-commits";
import { loadCommitViewData, renderCommitViewPage } from "./pages/commit-view";
import { createPullFromForm, loadCompareData, readComparePullForm, renderComparePage } from "./pages/compare";
import {
  applyRepoBasics,
  canAdminRepo,
  createHookFromForm,
  editHookFromForm,
  fireHookTestDelivery,
  hookDeliveryQueueOf,
  loadHookDetailData,
  loadHooksSettings,
  loadMirrorSettings,
  loadRepoBasics,
  mirrorLocale,
  parseCreateHookForm,
  parseHookEditForm,
  parseRepoBasicsForm,
  renderHookDetailPage,
  renderHooksSettingsPage,
  renderMirrorSettingsPage,
  renderRepoSettingsPage,
  syncMirrorNow,
} from "./pages/settings";
import {
  applyBranchDelete,
  loadBranchesData,
  parseBranchDeleteForm,
  renderBranchesPage,
} from "./pages/branches";
import {
  createReleaseFromForm,
  deleteReleaseFromForm,
  editReleaseFromForm,
  loadEditReleaseData,
  loadNewReleaseData,
  loadReleaseDetailData,
  loadReleasesData,
  latestReleaseTagOf,
  parseNewReleaseForm,
  renderNewReleasePage,
  renderReleaseDetailPage,
  parseEditReleaseForm,
  parseReleaseDeleteForm,
  renderEditReleasePage,
  renderReleasesPage,
} from "./pages/releases";
import { listReleases } from "../api/services/releases";
import {
  applyBranchProtectionForm,
  deleteRuleById,
  editFormOfRule,
  emptyBranchProtectionForm,
  loadBranchProtectionRules,
  loadOwnerIsOrg,
  parseBranchProtectionForm,
  parsePriorityIds,
  reorderRules,
  renderBranchProtectionEditPage,
  renderBranchProtectionListPage,
  type BranchProtectionEditData,
} from "./pages/branch-protection";
import { findIssueByRepoAndIndex } from "../api/services/issues";
import { deleteRepoHook, getOwnerHook, getRepoHook } from "../api/services/hooks";
import { findPullRequestByIndex } from "../api/services/pulls";
import { findRepositoryById } from "../api/services/repository";
import { toApiUser } from "../api/auth";
import { ApiError } from "../api/errors";
import { IssuesService } from "../issues/service";
import type { OrgRecord } from "../services/orgs/orgs";
// Window-2d: the four repo-settings tab modules.
import {
  applyRepoGitHook,
  loadRepoGitHookEdit,
  loadRepoGitHooks,
  parseRepoGitHookForm,
  renderRepoGitHookEditPage,
  renderRepoGitHooksListPage,
} from "./pages/repo-settings-githooks";
import {
  applyTagProtectionForm,
  deleteTagRuleById,
  editFormOfTag,
  emptyTagProtectionForm,
  loadProtectedTagRules,
  loadTagRuleById,
  parseTagProtectionForm,
  renderTagProtectionPage,
} from "./pages/repo-settings-tags";
import {
  addDeployKeyFromForm,
  deleteDeployKeyFromForm,
  loadRepoDeployKeys,
  parseDeployKeyDeleteForm,
  parseDeployKeyForm,
  renderRepoDeployKeysPage,
} from "./pages/repo-settings-deploy-keys";
import {
  loadRepoPublicAccess,
  parsePublicAccessForm,
  renderRepoPublicAccessPage,
  updateCodeUnitPublicAccess,
} from "./pages/repo-settings-public-access";
import {
  applyRepoWikiSettings,
  loadRepoWikiSettings,
  parseRepoWikiForm,
  renderRepoWikiSettingsPage,
} from "./pages/repo-settings-wiki";
// Window-2e: the aux/byte-surface modules.
import {
  loadHomeSitemapIndex,
  loadReposSitemap,
  loadUsersSitemap,
  parseSitemapIdx,
  sitemapXmlResponse,
} from "./pages/sitemap";
import {
  loadRepoSearchAux,
  loadTopicSearchAux,
  parseRepoSearchAuxQuery,
  parseTopicSearchAuxQuery,
  repoSearchAuxResponse,
  repoSearchCountOnlyResponse,
  SearchAuxParamError,
  topicSearchAuxResponse,
  type WebSearchAuxResults,
} from "./pages/search-aux";
import { resolveActivityFeeds } from "./pages/activity-feeds";
import {
  loadUserFeedData,
  renderUserFeedAtom,
  renderUserFeedRss,
  USER_FEED_CONTENT_TYPES,
} from "./pages/user-feed-xml";
// Window-2e B2: the repo-scoped aux/fragment modules.
import {
  issuesSearchResponse,
  issuesSuggestionsResponse,
  loadIssuesSearchAux,
  loadIssuesSuggestionsAux,
  suggestionsIsPullFilter,
} from "./pages/issues-search-aux";
import {
  contentHistoryOverviewFragmentResponse,
  issueAttachmentsFragmentResponse,
  issueInfoFragmentResponse,
  loadContentHistoryOverviewFragment,
  loadIssueAttachmentsFragment,
  loadIssueInfoFragment,
  resolveFragmentIssue,
} from "./pages/issue-content-fragments";
import { loadPullMergeBoxData, pullMergeBoxFragmentHtml, pullMergeBoxFragmentResponse } from "./pages/pull-merge-box";
import {
  compareFeedServerErrorResponse,
  compareFeedTextResponse,
  loadCompareFeed,
  loadPullFilesRange,
  parsePullFilesRange,
  renderPullFilesRangePage,
  type CompareFeedRepo,
} from "./pages/compare-feeds";
import {
  loadPullFilesSingleCommit,
  parsePullFilesSingleCommit,
  renderPullFilesSingleCommitPage,
} from "./pages/pull-files-single-commit";
import { activityAuthorDataResponse, loadActivityAuthorData } from "./pages/activity-author-data";
// Window-2e C2: the wiki family.
import {
  createWikiPageFromForm,
  deleteWikiPageFromForm,
  editWikiPageFromForm,
  loadWikiEditData,
  loadWikiPagesData,
  loadWikiRevisionData,
  loadWikiViewData,
  parseWikiPageForm,
  renderWikiEditPage,
  renderWikiNewPage,
  renderWikiPagesPage,
  renderWikiRevisionPage,
  renderWikiStartPage,
  renderWikiViewPage,
} from "./pages/repo-wiki";
import type { WikiDoer } from "../services/wiki";
// Window-2e C1: the global inbox.
import {
  loadDashboardMilestonesData,
  loadOverviewIssuesData,
  renderDashboardMilestonesPage,
  renderOverviewIssuesPage,
} from "./pages/global-inbox";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "./ui-context";
import { resolveViewer, type Viewer } from "./viewer";

// ---------------------------------------------------------------------------
// Route parsers (the single source of truth — handlesUiRoute and uiRouter
// both read them; §2.2 "route knowledge has exactly one owner")
// ---------------------------------------------------------------------------

/** The claimed UI page families (§2.1 inventory). */
export type UiFamily = "home" | "commits" | "src";

/** A repo-scoped path the UI router owns, fully decoded. */
export interface UiRoute {
  family: UiFamily;
  /** Decoded owner segment, request casing preserved (D1 lookup folds). */
  owner: string;
  /** Decoded repo segment with exactly one trailing `.git` trimmed (§4.4
   *  gate convention; repo names ending `.git` are reserved, so the trim is
   *  unambiguous). */
  repo: string;
  /** Decoded remainder after the family literal, "/"-joined; `null` = the
   *  bare family URL (`/commits`, `/src`). */
  refSuffix: string | null;
}

// ---------------------------------------------------------------------------
// Wave-2 families (SPEC-0008 U3 extension: the code-tree redirect + the
// issues/pulls lists). A separate union, NOT extra members of `UiRoute`:
// `render.tsx`'s page switch stays exhaustive over the slice-1 three (the
// strictNullChecks fall-off-the-switch check), and the wave-2 dispatch lives
// entirely in this router — render.tsx never sees these routes.
// ---------------------------------------------------------------------------

/** The `/tree` family (pages/repo-home.tsx): upstream RedirectRepoTreeToSrc —
 *  the RAW (still-encoded) suffix swaps verbatim onto `/src/`. */
export interface TreeRoute {
  family: "tree";
  owner: string;
  repo: string;
  /** The still-encoded path tail after `/tree`, "/"-joined segments
   *  (`ctx.PathParamRaw("*")` parity); "" = the bare `/tree` (no upstream
   *  route → the §4.5 404 shell). */
  rawSuffix: string;
}

/** The `/issues` and `/pulls` list families (pages/issues-list.tsx): the
 *  bare URLs — the wave-3 detail routes below own the single-index tails. */
export interface IssuesListRoute {
  family: "issues" | "pulls";
  owner: string;
  repo: string;
}

/** The wave-3 detail family (pages/issue-detail.tsx): `/issues/{index}` and
 *  `/pulls/{index}` — one component over the shared issue rows; `urlKind`
 *  records which literal addressed it (upstream ViewIssue redirects the
 *  mismatched family onto `Issue.Link()`, issue_view.go:347-352). */
export interface IssueDetailRoute {
  family: "issue-detail";
  owner: string;
  repo: string;
  urlKind: "issues" | "pulls";
  index: number;
}

/** The wave-4 new-issue family (pages/new-issue.tsx): the form GET + the
 *  write POST — upstream's `/issues/new` (routers/web/repo/issue.go
 *  NewIssue/NewIssuePost). */
export interface IssueNewRoute {
  family: "issue-new";
  owner: string;
  repo: string;
}

/** The wave-4 settings families (pages/settings.tsx): the basics form, the
 *  webhooks sub-page, the mirror panel — wave 10 — and the wave-14 per-hook
 *  page with its two POST tails, each GET + POST except the two POST-only
 *  tails — admin-viewer-only surfaces. Wave 15 adds the protected-branches
 *  family (pages/branch-protection.tsx): the list, the create/edit form
 *  (upstream's `/edit` literal keyed by `?rule_name=` on the GET), the
 *  id-keyed delete and the priority reorder POSTs — upstream's literal
 *  route shapes (web.go:1206-1212). */
export interface SettingsRoute {
  family:
    | "settings"
    | "settings-hooks"
    | "settings-mirror"
    | "settings-hook-detail"
    | "settings-hook-test"
    | "settings-hook-delete"
    | "settings-branches"
    | "settings-branch-edit"
    | "settings-branch-delete"
    | "settings-branch-priority"
    // Window-2d: the four settings-tab modules.
    | "settings-githooks" // GET /settings/hooks/git
    | "settings-githook" // GET+POST /settings/hooks/git/{name}
    | "settings-tags" // GET+POST /settings/tags
    | "settings-tags-delete" // POST /settings/tags/delete
    | "settings-tag-detail" // GET+POST /settings/tags/{id}
    | "settings-keys" // GET+POST /settings/keys
    | "settings-keys-delete" // POST /settings/keys/delete
    | "settings-public-access" // GET+POST /settings/public_access
    | "settings-wiki"; // GET+POST /settings/wiki (window-2d pass 2)
  owner: string;
  repo: string;
  /** The hook id (the detail/test/delete families only) or the rule id (the
   *  branch-delete family, the tag-detail family). */
  id?: number;
  /** The Git hook name (the settings-githook family). */
  name?: string;
}

/** The wave-5 comment-write family (pages/issue-detail.tsx): upstream
 *  `m.Combo("/comments").Post(...)` under both issue URL families
 *  (routers/web/web.go:1376) — POST-only, the `status` field carries the
 *  close/reopen toggle. */
export interface IssueCommentRoute {
  family: "issue-comment";
  owner: string;
  repo: string;
  urlKind: "issues" | "pulls";
  index: number;
}

/** The wave-5 label-write family (pages/issue-detail.tsx): upstream
 *  `POST /issues/labels` — the sidebar JS dropdown's `data-update-url`
 *  (sidebar/label_list.tmpl:4-6), POST-only, admin-viewer-only. */
export interface IssueLabelsRoute {
  family: "issue-labels";
  owner: string;
  repo: string;
}

/** The wave-5 PR files family (pages/pull-files.tsx): upstream
 *  `m.Group("/files")` under the pulls group (web.go:1670-1680) — GET. */
export interface PullFilesRoute {
  family: "pull-files";
  owner: string;
  repo: string;
  index: number;
}

/** The PR commits tab family (pages/pull-commits.tsx): upstream's
 *  `/{index}/commits` GET under the pulls group (web.go ViewPullCommits,
 *  routers/web/repo/pull.go:631-668) — the tab menu's middle member. */
export interface PullCommitsRoute {
  family: "pull-commits";
  owner: string;
  repo: string;
  index: number;
}

/** The wave-16 branches family (pages/branches.tsx): upstream's
 *  `m.Get("/branches", repo.Branches)` list page plus the
 *  `m.Post("/branches/delete", repo.DeleteBranchPost)` write (web.go:1478-
 *  1482's group). The bare URL is the list (anonymous-capable); the delete
 *  rides the literal `/delete` tail (upstream's exact shape; the branch
 *  name rides the form field — Go's FormString reads upstream's
 *  query-string carrier too). Every other tail (`/branches/abc`,
 *  `/_new/*`, `/restore`) stays engine-owned — upstream's
 *  unregistered-route 404. */
export interface BranchesRoute {
  family: "branches" | "branch-delete";
  owner: string;
  repo: string;
}

/** The wave-18 commit-view family (pages/commit-view.tsx): upstream's
 *  `m.Get("/commit/{sha:([a-f0-9]{7,64})$}", repo.Diff)` (web.go:1739) —
 *  the parity survey's #1 dead-end, the target of every commits-log /
 *  branches-list / PR-commits ShortSha link. The EXACT single-segment tail
 *  claims for ANY segment value (the hex-shape gate is the loader's 404
 *  arm — a non-hex segment, including a non-hex `foo.diff` dotted form,
 *  answers the §4.5 shell like upstream's pattern-miss 404); the DEEPER
 *  tails are lifted by their own families below (wave 29's dotted
 *  `{sha}.{diff|patch}` downloads — web.go:1760 — and wave 32's
 *  `{sha}/load-branches-and-tags` aux JSON — web.go:1740); junk stays
 *  engine-owned (see the page module's divergence notes). The bare
 *  `/commit` URL is unclaimed too (upstream has no such route). */
export interface CommitViewRoute {
  family: "commit-view";
  owner: string;
  repo: string;
  /** The decoded sha segment (validated at load time, not parse time). */
  sha: string;
}

/** The wave-20 releases family (pages/releases.tsx): upstream's releases
 *  group (web.go:1505-1514 — the parity survey's #4; the whole data side is
 *  landed, api/services/releases.ts + release-assets.ts + the SPEC-0005
 *  create arm): the bare URL is the list (`repo.Releases`, web.go:1506),
 *  `/releases/new` the create form + write (web.go:1517-1518, the writer
 *  gate), `/releases/latest` the latest-release 303 (web.go:1510 —
 *  `ctx.Redirect(release.Link())`), `/releases/tag/*` the single-release
 *  page (web.go:1509 `repo.SingleRelease` — the SAME list template over one
 *  row; the tail is the decoded tag name, slashes allowed, so the emitted
 *  `/releases/tag/{tag}` links — the API family's html_url shape — re-parse
 *  to the same route). Wave 33 (the survey's top-5 #4) adds the write
 *  group's edit/delete tails: `/releases/edit/*` the edit form + write
 *  (web.go:1519-1520 EditRelease/EditReleasePost — the writer gate, the
 *  decoded tail the URL-keyed tag, slashes allowed) and `/releases/delete`
 *  the delete write (web.go:1523 DeleteRelease — the edit page's red
 *  button). The `.rss`/`.atom` feed tails (web.go:1507-1508), the
 *  `/generate-notes` and `/attachments*` write tails and the
 *  `{id}/reactions` POST (web.go:1511-1526) stay unclaimed → the engine's
 *  404, exactly upstream's unregistered-route answer for them. */
export interface ReleasesRoute {
  family: "releases" | "release-new" | "release-latest" | "release-detail" | "release-edit" | "release-delete";
  owner: string;
  repo: string;
  /** The decoded tag tail after `/releases/tag/` (the detail family only;
   *  may bear slashes — refnames do) or after `/releases/edit/` (the edit
   *  family — the URL-keyed tag the loader resolves). */
  tag?: string;
}

/** The wave-41 releases download tail (pages/release-downloads.ts): upstream
 *  web.go:1513's `m.Get("/releases/attachments/{uuid}",
 *  repo.GetAttachment)` and web.go:1514's
 *  `m.Get("/releases/download/{vTag}/{fileName}", repo.RedirectDownload)` —
 *  the parity survey's top-5 #1, the serving half of the landed
 *  release-assets data (the download pages' links answer here). Both are
 *  binary serves, not pages; the routes sit in the releases group's gates
 *  (MustBeNotEmpty + reqRepoReleaseReader — the hasReleases unit gate). */
export interface ReleaseDownloadRoute {
  family: "release-attachment" | "release-download";
  owner: string;
  repo: string;
  /** The decoded uuid segment (the attachments family). */
  uuid?: string;
  /** The decoded {vTag}/{fileName} pair (the download family — chi's
   *  single-segment params, so a literal slash in either 404s upstream). */
  vTag?: string;
  fileName?: string;
}

/** The wave-41 rendered blob views (pages/render-files.ts): upstream
 *  web.go:1715-1719's `/render` group — the three typed ref sub-routes over
 *  `repo.RenderFile` and the `/render/blob/{sha}` arm — the standalone-page
 *  renders the official bundle's external-render iframe fetches. Not a page
 *  family: the answer is a bare HTML fragment (or the "Unable to find
 *  renderer" 400 class — the module doc carries the pipeline mapping). */
export interface RenderFileRoute {
  family: "render-file";
  owner: string;
  repo: string;
  /** The typed-ref arms: the ref-type literal + the decoded ref+path suffix
   *  (the /src family's shape). */
  refType?: RefType;
  refSuffix?: string;
  /** The blob arm's decoded sha segment. */
  sha?: string;
}

/** The wave-19 creation families (pages/repo-create.tsx + pages/
 *  org-create.tsx): upstream's reqSignIn `/repo/create` and `/org/create`
 *  groups (web.go:1094-1098 + 970-974 — the parity survey's #2, the
 *  authoring front door) — GET the form, POST the landed create arms
 *  (`POST /user/repos` / `POST /orgs/{org}/repos` user-repos + org-repos,
 *  and `POST /orgs`), success 303 onto the created owner's page. Claimed as
 *  EXACT literals before the owner/repo parse could read them as a
 *  repository named "create" under an owner named "repo"/"org" (the
 *  user-settings precedent; upstream's groups register ahead of the dynamic
 *  pairs and shadow such a repository identically). Every other
 *  `/repo|org/*` tail stays unclaimed → the engine's 404. */
export interface RepoCreateRoute {
  family: "repo-create";
}

export interface OrgCreateRoute {
  family: "org-create";
}

/** The wave-23 org members family (pages/org-members.tsx): upstream's
 *  `/org/{org}/members` literal (web.go:957-961, the `/org` group ahead of
 *  the dynamic pairs — a repository path `/org/{repo}/members` is shadowed
 *  identically, and the "org" owner name is create-time reserved besides,
 *  the repo-create precedent). The owner segment is the {org} param;
 *  anonymous-capable (the group's `optSignIn` is RequireSignInViewStrict,
 *  off at the pin) — the members listing's PublicOnly scope is the per-row
 *  gate. Every other `/org/*` tail stays unclaimed → the engine's 404. */
export interface OrgMembersRoute {
  family: "org-members";
  /** Decoded org segment (the upstream {org} param). */
  owner: string;
}

/** The wave-23 org repositories family (pages/org-repos.tsx): upstream's
 *  `/{username}/-/repositories` (web.go:1107's `/{username}/-` group's
 *  web.go:1134 repositories route) — the `-` pseudo-segment namespace claims
 *  exactly the repositories tail; a plain USER name 404-shells at resolve
 *  time (upstream org.Repositories' `org == nil` arm). Every other `/-*`
 *  tail (heatmap, packages, code) stays unclaimed → the engine's 404
 *  (projects landed in wave 37 — pages/owner-projects.tsx). */
export interface OrgRepositoriesRoute {
  family: "org-repositories";
  /** Decoded owner segment (org rows only at resolve time). */
  owner: string;
}

/** The wave-37 owner projects list family (pages/owner-projects.tsx):
 *  upstream's `/{username}/-/projects` (web.go:1107's `/{username}/-`
 *  group's read group, web.go:1143-1145 — `m.Get("", org.Projects)` plus
 *  the `/{id}` board tails) — the parity survey's regenerated top-5 row 5.
 *  The `-` pseudo-segment namespace claims EXACTLY the bare projects tail;
 *  the owner resolves user-or-org at load time (upstream's single handler
 *  branches on ContextUser.IsOrganization). Wave 40 (pages/
 *  owner-project-board.tsx) claims the board depth and the write group —
 *  the survey's follow-up row. */
export interface OwnerProjectsRoute {
  family: "owner-projects";
  /** Decoded owner segment (user-or-org rows at resolve time). */
  owner: string;
}

/** The wave-40 owner projects BOARD families (pages/owner-project-board.tsx):
 *  upstream's web.go:1140-1155 board view + write group (the survey's
 *  follow-up row) over the `/-/projects` depth — `/{id}` the board view
 *  (org.ViewProject), `/new` + `/{id}/edit` the GET+POST form combos,
 *  `/{id}/delete` + `/{id}/open|close` the POST writes, `/{id}/columns/new`
 *  + `/{id}/{columnID}/default` the form-compatible board-helper POSTs
 *  (addProjectBoardRoutes, web.go:331-345), and the `/{id}/workflows[/{wid}
 *  [/delete]]` workflow tails (addProjectWorkflowRoutes, web.go:327-331).
 *  The `new` literal outranks the numeric `{id}` shapes (upstream registers
 *  it first, chi tree order); the id shapes claim positive integers only —
 *  a junk segment stays unclaimed → the engine's 404 (upstream's
 *  PathParamInt64-zero ServerError 500 arm, the landed uniform not-found
 *  answer). The board-helper arms whose upstream methods are PUT/DELETE
 *  (`/{columnID}`) or whose controls are pure drag-drop JSON fetches
 *  (`/move`, `/{columnID}/move`) stay unclaimed → the engine's 404 — the
 *  page module documents the no-JS reductions, never dead controls. */
export interface OwnerProjectBoardRoute {
  family:
    | "owner-project-board" // GET /{id}
    | "owner-project-new" // GET+POST /new
    | "owner-project-edit" // GET+POST /{id}/edit
    | "owner-project-delete" // POST /{id}/delete
    | "owner-project-status" // POST /{id}/open|close
    | "owner-project-column-new" // POST /{id}/columns/new
    | "owner-project-column-default" // POST /{id}/{columnID}/default
    | "owner-project-workflows" // GET+POST /{id}/workflows[/{wid}]
    | "owner-project-workflow-delete" // POST /{id}/workflows/{wid}/delete
  ;
  /** Decoded owner segment (user-or-org rows at resolve time). */
  owner: string;
  /** The parsed board id (the numeric families; "new" carries none). */
  id?: number;
  /** open|close (the status family only). */
  action?: "open" | "close";
  /** The column id (the column-default family only). */
  columnId?: number;
  /** The workflow id (the workflows-with-wid and workflow-delete families). */
  workflowId?: number;
}

/** The wave-45 repo projects families (pages/repo-projects.tsx): upstream's
 *  `/{username}/{reponame}/projects` group (web.go:1544-1563 — the survey's
 *  re-ranked #1, the F-family row the restored `repo === "-"` guard held):
 *  the bare literal the LIST (repo.Projects), `/new` the write group's
 *  GET+POST form combo, `/{id}` the board view (repo.ViewProject), the
 *  `/{id}/edit|delete|open|close` project writes, `/{id}/columns/new` +
 *  `/{id}/{columnID}/default` the form-compatible board-helper POSTs
 *  (addProjectBoardRoutes' live half), and the
 *  `/{id}/workflows[/{wid}[/delete]]` workflow tails (addProjectWorkflowRoutes
 *  — repo.ProjectWorkflows → RenderWorkflows). The `new` literal outranks
 *  the numeric `{id}` shapes (upstream registers it first, chi tree order);
 *  the id shapes claim positive integers only — a junk segment stays
 *  unclaimed → the engine's 404 (upstream's PathParamInt64-zero ServerError
 *  arm, the landed uniform not-found answer). The board-helper arms whose
 *  upstream methods are PUT/DELETE (`/{columnID}`) or whose controls are
 *  pure drag-drop JSON fetches (`/move`, `/{columnID}/move`) stay unclaimed
 *  → the engine's 404 — the owner-board posture, page module documents the
 *  no-JS reductions. The group's gates (MustEnableRepoProjects reduced to
 *  the loaded `repoHasProjects` toggle; the write ladder =
 *  reqRepoProjectsWriter + RepoMustNotBeArchived → the shared repo write
 *  gate) run at the handlers. */
export interface RepoProjectsRoute {
  family:
    | "repo-projects" // GET /projects
    | "repo-project-new" // GET+POST /projects/new
    | "repo-project-board" // GET /projects/{id}
    | "repo-project-edit" // GET+POST /projects/{id}/edit
    | "repo-project-delete" // POST /projects/{id}/delete
    | "repo-project-status" // POST /projects/{id}/open|close
    | "repo-project-column-new" // POST /projects/{id}/columns/new
    | "repo-project-column-default" // POST /projects/{id}/{columnID}/default
    | "repo-project-workflows" // GET+POST /projects/{id}/workflows[/{wid}]
    | "repo-project-workflow-delete" // POST /projects/{id}/workflows/{wid}/delete
  ;
  owner: string;
  repo: string;
  /** The parsed board id (the numeric families; "new" carries none). */
  id?: number;
  /** open|close (the status family only). */
  action?: "open" | "close";
  /** The column id (the column-default family only). */
  columnId?: number;
  /** The workflow id (the workflows-with-wid and workflow-delete families). */
  workflowId?: number;
}

/** The wave-24 repo social list families (pages/repo-social.tsx): upstream's
 *  three bare repo-scoped literals — `/forks` (web.go:1759), `/stars`
 *  (web.go:1766), `/watchers` (web.go:1767) — the parity survey's bench
 *  trio, one `listRefs`-free read each over the landed social/fork services.
 *  GET-only; every deeper tail stays unclaimed → the engine's 404. */
export interface RepoSocialRoute {
  family: "forks" | "stars" | "watchers";
  owner: string;
  repo: string;
}

/** The wave-24 collaboration settings family (pages/settings-collaboration.tsx):
 *  upstream's `/settings/collaboration` group (web.go:1194-1204) — the
 *  `m.Combo("")` panel (GET the render, POST the add-collaborator write)
 *  plus the four POST-only write tails with upstream's exact literal names
 *  (the JS dropdown's /access_mode, the /delete remove, the org team
 *  /team add and /team/delete remove; the ids ride the form fields —
 *  upstream's FormInt64 carriers). */
export interface SettingsCollaborationRoute {
  family:
    | "settings-collaboration"
    | "settings-collab-access-mode"
    | "settings-collab-delete"
    | "settings-collab-team-add"
    | "settings-collab-team-delete";
  owner: string;
  repo: string;
}

/** The wave-25 tags family (pages/tags.tsx + pages/tag-list-aux.ts):
 *  upstream's repo tags group's list route (web.go:1493-1496 —
 *  `m.Get("", context.RepoRefByDefaultBranch(), repo.TagsList)` under the
 *  `/tags` group) — the parity survey's TOP-1 row, the bare repo-scoped
 *  literal over the engine ref universe. Wave 33 (the survey's top-5 #2)
 *  adds the group's other two routes: `/tags/list` the aux JSON
 *  (web.go:1499 GetTagList — the `{"results":[names]}` branchTagSearchResponse
 *  shape, GET-only, pages/tag-list-aux.ts) and `/tags/delete` the delete
 *  write (web.go:1501 — reqSignIn + reqRepoCodeWriter +
 *  RepoMustNotBeArchived, POST-only, the tags page's per-row control). The
 *  `.rss`/`.atom` feed tails and every deeper tail stay unclaimed → the
 *  engine's 404, exactly upstream's unregistered-route answer. */
export interface TagsRoute {
  family: "tags" | "tags-list-aux" | "tags-delete";
  owner: string;
  repo: string;
}

/** The wave-25 repo labels families (pages/repo-labels.tsx): upstream's
 *  labels page (web.go:1338 `repo.RetrieveLabelsForList, repo.Labels` in
 *  the optSignIn + reqRepoIssuesOrPullsReader group — anonymous-capable)
 *  plus the three POST write tails (`/labels/new`, `/labels/edit`,
 *  `/labels/delete` — web.go:1417-1422 under reqSignIn +
 *  RepoMustNotBeArchived + reqRepoIssuesOrPullsWriter; the survey's TOP-2
 *  row). The repo-scoped `labels` THIRD segment never collides with the
 *  wave-14 org literal (which claims `/{org}/labels` — `labels` as the
 *  SECOND segment — upstream shadows that repo identically). The
 *  `/labels/initialize` template loader and every deeper tail stay
 *  unclaimed → the engine's 404. */
export interface RepoLabelsRoute {
  family: "repo-labels" | "repo-label-new" | "repo-label-edit" | "repo-label-delete";
  owner: string;
  repo: string;
}

/** The wave-26 milestone detail family (pages/milestone-detail.tsx):
 *  upstream's SINGULAR `m.Get("/milestone/{id}", repo.MilestoneIssuesAndPulls)`
 *  (web.go:1340 — the parity survey's TOP-3 row, the milestones LIST's
 *  title-link target; the plural /milestones group never claimed this
 *  shape). The exact single-segment tail is claimed for ANY segment value —
 *  a non-numeric or foreign id 404-shells through the loader (upstream
 *  PathParamInt64's zero + GetMilestoneByRepoID's NotFound), the
 *  commit-view sha convention. Deeper tails (`/{id}/foo`) stay unclaimed →
 *  the engine's 404 (upstream registers none here either). */
export interface MilestoneDetailRoute {
  family: "milestone-detail";
  owner: string;
  repo: string;
  /** The decoded id segment (validated at load time, not parse time). */
  id: string;
}

/** The wave-26 milestone edit family (pages/milestone-detail.tsx): the
 *  `{id}/edit` combo under the plural /milestones group (web.go:1427-1428 —
 *  `m.Get("/{id}/edit", repo.EditMilestone)` + the POST
 *  EditMilestonePost), the write group's gate running at the handlers (the
 *  labels-write convention). Upstream's sibling writes — `/{id}/{action}`
 *  (ChangeMilestoneStatus close/open) and `/delete` — stay unclaimed → the
 *  engine's 404: this slice renders no dead controls for them. */
export interface MilestoneEditRoute {
  family: "milestone-edit";
  owner: string;
  repo: string;
  /** The decoded id segment (validated at load time, not parse time). */
  id: string;
}

/** The wave-26 fork-form family (pages/repo-fork.tsx): upstream's
 *  `m.Combo("/fork").Get(repo.Fork).Post(...)` (web.go:1490 — the survey's
 *  TOP-5 row, DISTINCT from the landed forks LIST literal which claims the
 *  bare `/forks`). The signed-in gate + the empty-source 404 run at the
 *  handlers (upstream reqSignIn + getForkRepository's IsEmpty arm); the
 *  deeper `/fork/*` tails stay unclaimed → the engine's 404. */
export interface RepoForkRoute {
  family: "repo-fork";
  owner: string;
  repo: string;
}

/** The wave-29 diffpatch download family (pages/diffpatch-files.ts): the
 *  four raw-text routes — upstream web.go:1760's
 *  `/commit/{sha:([a-f0-9]{7,64})}.{ext:patch|diff}` (repo.RawDiff) and
 *  web.go:1657-1658's `/{index}.diff` + `/{index}.patch` under the pulls
 *  group (repo.DownloadPullDiff/Patch). The commit arm claims the DOTTED
 *  hex-shaped segment (7..64, case-folded — the load-time shape gate) out of
 *  wave-18's any-value single tail; every other segment keeps the commit-view
 *  claim (a non-hex `foo.diff` 404-shells there, upstream's pattern miss).
 *  The pull arm admits `\\d+.{diff|patch}` exactly (the landed API seam's
 *  convention — a negative or junk index upstream-404s too, chi's
 *  PathParamInt64 miss). The response is raw TEXT, not a page (the module
 *  doc carries the contract). */
export interface DiffPatchRoute {
  family: "commit-diffpatch" | "pull-diffpatch";
  owner: string;
  repo: string;
  /** The commit family: the sha segment before the `.ext` suffix. */
  sha?: string;
  /** The pull family: the numeric index. */
  index?: number;
  /** The raw format the `.ext` suffix picked. */
  ext: "diff" | "patch";
}

/** The wave-32 archive download family (pages/archive-files.ts): upstream
 *  web.go:1689's `m.Get("/*", repo.Download)` under the /archive group —
 *  the wildcard tail is `REF.zip` | `REF.tar.gz` (`.bundle` parses upstream
 *  as a third format; the builder refuses, the 400 class), multi-segment
 *  ref names included, the BARE `/archive` claimed too (chi's `/*` matches
 *  the empty tail; `SplitArchiveNameType("")` is the same 400 arm). The
 *  response is a streamed FILE, not a page (the module doc carries the
 *  header matrix); the POST half (InitiateDownload, web.go:1690) stays
 *  engine-owned. */
export interface RepoArchiveRoute {
  family: "repo-archive";
  owner: string;
  repo: string;
  /** The wildcard tail verbatim ("" for the bare URL): `REF.{zip|tar.gz}`. */
  refExt: string;
}

/** The wave-32 commit aux-JSON family (pages/commit-contained-refs.ts):
 *  upstream web.go:1740's
 *  `{sha:([a-f0-9]{7,64})}/load-branches-and-tags` — the HEX-shaped sha
 *  lifts out of wave-18's single-tail view claim (a non-hex sha with the
 *  literal tail is upstream's pattern miss → engine-owned). The response is
 *  JSON, not a page (the module doc carries the shape + cost posture). */
export interface CommitContainedRefsRoute {
  family: "commit-contained-refs";
  owner: string;
  repo: string;
  /** The commit sha segment (hex-shaped 7..64, case-folded). */
  sha: string;
}

/** The wave-39 pasted-blob-URL redirect family (pages/repo-home.tsx's
 *  blobRedirectResponse): upstream web.go:1757's `m.Get("/blob/*",
 *  repo.RedirectRepoBlobToCommit)` — the wave-2 tree-redirect twin, the RAW
 *  (still-encoded) suffix swapped verbatim onto `/src/commit/`. */
export interface BlobRedirectRoute {
  family: "blob-redirect";
  owner: string;
  repo: string;
  /** The still-encoded path tail after `/blob` (`ctx.PathParamRaw("*")`
   *  parity); "" = the bare `/blob` (no upstream route → the §4.5 404
   *  shell, the tree family's arm). */
  rawSuffix: string;
}

/** The wave-39 find-file aux-JSON family (pages/tree-list-aux.ts): upstream
 *  web.go:1297-1306's `/{branch|tag|commit}/*` sub-routes over
 *  `repo.TreeList` — the ref-type literal is the route shape (the forced-type
 *  middleware), the decoded tail is the ref+path suffix (the /src family's
 *  shape; the handler walks the ROOT tree, the tail's path half is ignored —
 *  the module doc). The response is JSON, not a page. */
export interface TreeListAuxRoute {
  family: "tree-list-aux";
  owner: string;
  repo: string;
  /** The forced ref type (web.go:1298-1300's three sub-routes). */
  refType: RefType;
  /** The decoded ref+path tail after the type literal. */
  refSuffix: string;
}

/** The wave-39 branches aux-JSON family (pages/branches-list-aux.ts):
 *  upstream web.go:1695's `m.Get("/list", repo.GetBranchesList)` under the
 *  `/branches` group — the `{"results":[names]}` feed (the wave-33
 *  tags-list-aux twin; the group's MustBeNotEmpty 404-shells empty repos at
 *  the handler). The response is JSON, not a page. */
export interface BranchesListAuxRoute {
  family: "branches-list-aux";
  owner: string;
  repo: string;
}

/** The wave-43 tree-view envelope family (pages/tree-view-aux.ts): upstream
 *  web.go:1302-1306's `/{branch|tag|commit}/*` sub-routes over
 *  `repo.TreeViewNodes` (routers/web/repo/treelist.go:147-155) — the
 *  tree-list twin's route shape (the ref-type literal is the route shape,
 *  the decoded tail is the ref+path suffix, the /src family's shape), with
 *  the tail's PATH half now MEANINGFUL (the listing roots at it) and the
 *  `?sub_path=` query naming the expansion chain. The response is the
 *  `{fileTreeNodes, renderedIconPool}` JSON envelope, not a page. */
export interface TreeViewAuxRoute {
  family: "tree-view-aux";
  owner: string;
  repo: string;
  /** The forced ref type (web.go:1302-1306's three sub-routes). */
  refType: RefType;
  /** The decoded ref+path tail after the type literal. */
  refSuffix: string;
}

/** The wave-46 lastcommit fragment family (pages/repo-lastcommit-fragment.tsx
 *  — the machinery wave's route handoff): upstream web.go:1761's
 *  `m.Get("/lastcommit/*", context.RepoRefByType(git.RefTypeCommit),
 *  repo.LastCommit)` — the wildcard tail is the commit id + treePath
 *  (repo.go:915-921: the first segment is the 7..64-hex-shaped object id, the
 *  remainder the listed directory; the bare tail is upstream's default-branch
 *  arm, the landed convention's 404-shell divergence — the module doc's HEAD
 *  note). The response is the tplRepoViewList HTML fragment, not a page. */
export interface LastCommitRoute {
  family: "lastcommit";
  owner: string;
  repo: string;
  /** The decoded `/lastcommit` tail (per-segment decode —
   *  parseLastCommitTail's input contract; `""` = the bare URL). */
  rawTail: string;
}

/** The wave-46 blob-excerpt fragment families (pages/repo-blob-excerpt-
 *  fragment.tsx — the machinery's stage 3): upstream web.go:1735's
 *  `m.Get("/blob_excerpt/{sha}", …)` repo twin and web.go:1618's wiki twin
 *  (the `/{username}/{reponame}/wiki` group — PageIsWiki swaps the read onto
 *  the sibling wiki storage repo and the buttons' BaseLink). `{sha}` is a
 *  plain chi single-segment param (NO hex shape — any value; the handler's
 *  GetCommit miss is the 404 family). The response is the tplBlobExcerpt
 *  `<tr>` fragment, not a page. */
export interface BlobExcerptRoute {
  family: "blob-excerpt" | "wiki-blob-excerpt";
  owner: string;
  repo: string;
  /** The decoded `{sha}` segment (the after-commit id, unvalidated). */
  sha: string;
}


/** The wave-11 review-write families (pages/pull-reviews.tsx): upstream's
 *  three web POSTs — the verdict form's
 *  `/pulls/{index}/files/reviews/submit` (web.go:1678, the index rides the
 *  URL) and the repo-scoped `/issues/request_review` + `/issues/
 *  dismiss_review` (web.go:1435-1436, the issue/review ids ride the form —
 *  exactly upstream's field-carried shapes). POST-only. */
export interface PullReviewRoute {
  family: "pull-review-submit" | "issue-request-review" | "issue-dismiss-review";
  owner: string;
  repo: string;
  /** The PR index (the submit family only). */
  index?: number;
}

/** The wave-6 milestones list family (pages/milestones.tsx): upstream
 *  `m.Get("/milestones", repo.Milestones)` (web.go:1339) — GET, `?state=`
 *  facet. Wave 26 moved the `{id}/edit` claim into MilestoneEditRoute and
 *  the singular `/milestone/{id}` detail into MilestoneDetailRoute; the
 *  remaining tails (`/{id}/{action}`, `/delete`) stay engine-owned. */
export interface MilestonesRoute {
  family: "milestones";
  owner: string;
  repo: string;
}

/** The wave-6 new-milestone family (pages/milestones.tsx): upstream
 *  `m.Combo("/new").Get(repo.NewMilestone).Post(repo.NewMilestonePost)`
 *  under the /milestones group (web.go:1424-1425). */
export interface MilestoneNewRoute {
  family: "milestone-new";
  owner: string;
  repo: string;
}

/** The wave-6 single-segment family — EXTENDED in wave 7 into the OWNER
 *  home (pages/org-home.tsx + pages/user-profile.tsx): upstream's
 *  `/{username}` route answers user AND org names through one handler
 *  (`OwnerProfile` — routers/web/user/profile.go:37, dispatching on
 *  `ContextUser.IsOrganization()`), so ONE parse family owns the shape and
 *  the resolution picks the page: an org row renders the org home (the wave-6
 *  `resolveOrgHome` seam), a user row the user profile, a renamed name 307s
 *  onto the target. The dispatcher never consults `handlesUiRoute` for it
 *  (single-segment requests fall straight to `app.fetch`, where this
 *  sub-app's registration answers), but the parser is still the single
 *  owner of the shape. */
export interface OwnerHomeRoute {
  family: "owner-home";
  /** Decoded owner segment — the user or org name. */
  owner: string;
}

/** Window-2e: the user/org feed envelopes (pages/user-feed-xml.ts —
 *  upstream UsernameSubRoute's .rss/.atom suffix dispatch serves ORGS too,
 *  profile.go:33). */
export interface UserFeedRoute {
  family: "user-feed-rss" | "user-feed-atom";
  /** The owner segment with the suffix stripped. */
  owner: string;
}

/** Window-2e C1: the global inbox pages (pages/global-inbox.tsx). */
export interface GlobalInboxRoute {
  family: "global-issues" | "global-pulls" | "global-milestones";
}

/** Window-2e C2: the wiki family (pages/repo-wiki.tsx — the ?action=
 *  dispatch happens in the handler, per the module's verified grammar). */
export interface WikiRoute {
  family: "wiki";
  owner: string;
  repo: string;
  /** The wildcard tail VERBATIM (decoded; "" → the Home page). */
  rawTail: string;
}

/** The wave-8 file-editor family (pages/file-editor.tsx): upstream's
 *  `/{editor_action:_edit|_new|_delete}/*` Combos under
 *  `RepoRefByType(git.RefTypeBranch)` (web.go:1453-1461) at the wave brief's
 *  literal names (`new`/`edit`/`delete`). The tail is the decoded
 *  branch+path rest; it resolves against the BRANCH universe only at page
 *  time (pages/file-editor.tsx's loadFileEditorData — the /src walk's
 *  branch arm, so a slash-bearing branch takes the shortest existing
 *  prefix). The bare literals stay unclaimed: upstream chi's `/*` requires
 *  the tail too. */
export interface FileEditorRoute {
  family: "file-new" | "file-edit" | "file-delete";
  owner: string;
  repo: string;
  /** Decoded branch+path tail after the family literal (never claimed
   *  empty). */
  refSuffix: string;
}

/** The wave-9 site root (pages/dashboard.tsx): upstream `Home`
 *  (routers/web/home.go:26-44) — `/` serves the signed-in dashboard, the
 *  anonymous landing. The dispatcher never consults `handlesUiRoute` for it
 *  (the root is not repo-scoped; the uiRouter registration answers), but the
 *  parser stays the single owner of the shape. */
export interface SiteHomeRoute {
  family: "site-home";
}

/** The wave-10 notifications family (pages/notifications.tsx): upstream's
 *  web notifications group (web.go:1784-1791, reqSignIn) at the literal
 *  `/notifications` — the list page; `/notifications/new` the unread-count
 *  JSON; `/notifications/status` + `/notifications/purge` the POST-only
 *  writes. Claimed as EXACT literals before the owner-home parse could read
 *  `/notifications` as a username (the explore precedent; the literals bind
 *  case-sensitively, so `/Notifications` stays an owner home) and before the
 *  repo-scoped parse could read `/notifications/status` as an
 *  owner/repo pair — the dispatcher consults `handlesUiRoute` for those
 *  two-segment shapes, so the claims keep the sub-app's reach equal to the
 *  parser's. The deeper tails (`subscriptions`, `watching`) are not in this
 *  slice and stay unclaimed → the engine answers, exactly upstream's
 *  unregistered-route 404. */
export interface NotificationsRoute {
  family: "notifications" | "notification-new" | "notification-status" | "notification-purge";
}

/** The wave-9 explore family (pages/explore.tsx): upstream's route group
 *  `m.Group("/explore", …)` (web.go:549-556) — the bare `/explore` redirects
 *  onto `/explore/repos`, which renders the repo search page;
 *  `/explore/users` the user search page. Claimed by EXACT literal shapes
 *  before the owner/repo parse could read `/explore/repos` as a
 *  `{owner: "explore", repo: "repos"}` repository; every other `/explore/*`
 *  tail (organizations/code/sitemap-*, deeper) stays unclaimed → the
 *  engine/parent answer, exactly upstream's unregistered-route 404. */
export interface ExploreRoute {
  family: "explore-root" | "explore-repos" | "explore-users";
}

/** Window-2e: the sitemap families (pages/sitemap.ts — upstream web.go:530,
 *  554, 556). */
export interface SitemapRoute {
  family: "home-sitemap" | "explore-repos-sitemap" | "explore-users-sitemap";
  /** The parsed sub-sitemap index (chi's PathParamInt-0→page-1 cascade);
   *  absent on the index family. */
  idx?: number;
}

/** Window-2e: the search aux feeds (pages/search-aux.ts — repo.SearchRepo
 *  web.go:1102 + explore.TopicSearch web.go:564). */
export interface SearchAuxRoute {
  family: "repo-search-aux" | "explore-topic-search-aux";
}

/** Window-2e B2: the repo-scoped aux feeds + fragments (issues-search-aux,
 *  issue-content-fragments, pull-merge-box, compare-feeds,
 *  pull-files-single-commit, activity-author-data). */
export interface IssueAuxRoute {
  family:
    | "issues-search-aux"
    | "issues-suggestions-aux"
    | "issue-info"
    | "issue-attachments"
    | "issue-content-overview"
    | "issue-attachments-alias"
    | "pull-merge-box"
    | "pull-files-range"
    | "pull-commit-files"
    | "activity-author-data"
    | "compare-feed";
  owner: string;
  repo: string;
  /** The issue/PR index (the fragment families). */
  index?: number;
  /** issues vs pulls (the shared fragment arms). */
  urlKind?: "issues" | "pulls";
  /** The raw tail segment (files-range pair, single-commit sha,
   *  attachments uuid, activity period). */
  segment?: string;
  /** The feed extension (the compare-feed family). */
  ext?: "diff" | "patch";
}

/** The wave-12 user settings family (pages/user-settings.tsx): upstream's
 *  literal `/user/settings` (routers/web/shared/user settings header +
 *  user/settings/profile.tmpl — web.go's /user group registers ahead of the
 *  dynamic pairs, so upstream shadows a `{user: "user", repo: "settings"}`
 *  repository identically; "user" is additionally a reserved username,
 *  orgs.ts's RESERVED_USERNAMES port). The deeper settings tails (account,
 *  security, applications, keys, …) stay unclaimed → the engine's 404: no
 *  landed surfaces. */
export interface UserSettingsRoute {
  family: "user-settings";
}

/** Window-2c: the admin family (pages/admin-dashboard.tsx + pages/
 *  admin-monitor.tsx — upstream's /-/admin group). */
export interface AdminRoute {
  family: "admin-dashboard" | "admin-monitor";
  /** The monitor page (stats/cron/queue/stacktrace → the module's
   *  AdminMonitorPage union); absent on the dashboard family. */
  page?: "stats" | "cron" | "queue" | "trace";
}

/** Window-2a: the user-settings tab families (the two-stage module wave —
 *  each tab module's header carries its route recipe; upstream's
 *  reqSignIn /user/settings/* groups, web.go:646-746). Same literal posture
 *  as the bare claim below: "user" is reserved and the /user group
 *  registers ahead of the dynamic pairs. */
export interface UserSettingsTabRoute {
  family:
    | "user-settings-appearance"
    | "user-settings-appearance-theme"
    | "user-settings-appearance-language"
    | "user-settings-security"
    | "user-settings-secrets"
    | "user-settings-secrets-delete"
    | "user-settings-variables"
    | "user-settings-variables-new"
    | "user-settings-variables-edit"
    | "user-settings-variables-delete"
    | "user-settings-hooks"
    | "user-settings-hook-detail"
    | "user-settings-hook-delete"
    | "user-settings-keys"
    | "user-settings-keys-delete"
    | "user-settings-applications"
    | "user-settings-applications-delete"
    | "user-settings-organizations"
    | "user-settings-organizations-leave";
  /** The numeric path segment (hook/variable id), already parsed. */
  id: number | null;
}

/** The wave-12 org teams families (pages/org-teams.tsx): upstream's
 *  `/{org}/teams` group (web.go:993-1013) at the landed API shapes — the
 *  list, the id-keyed detail slice (upstream links by team name; the slice
 *  follows the landed /teams/{id} read arms), and the create form. The
 *  literal `teams` second segment claims the shapes before the repo parse
 *  could read them as a repository named "teams" — upstream shadows such a
 *  repo identically (web.go:993 registers ahead of :1292's
 *  `/{username}/{reponame}`). The deeper tails (`/{id}/repositories`,
 *  `/{id}/edit`, `/{id}/delete`, the `/action/*` writes) stay unclaimed →
 *  the engine's 404. */
export interface OrgTeamsRoute {
  family: "org-teams" | "org-team-new" | "org-team-detail";
  /** Decoded org segment. */
  owner: string;
  /** The team id (the detail family only). */
  id?: number;
}

/** The wave-14 org labels management families (pages/org-labels.tsx): the
 *  brief's literal `/{org}/labels` page plus upstream's three POST segments
 *  (`/labels/new`, `/labels/edit`, `/labels/delete` — web.go:1043-1048's
 *  writes; the brief's literal claims the `labels` second segment before the
 *  repo parse, the teams precedent). The `/labels/initialize` template
 *  loader and any deeper tail stay unclaimed → the engine's 404. */
export interface OrgLabelsRoute {
  family: "org-labels" | "org-label-new" | "org-label-edit" | "org-label-delete";
  /** Decoded org segment. */
  owner: string;
}

/** The wave-49 org settings + team-edit families (pages/org-settings.tsx):
 *  upstream's require-owner `/{org}` group — web.go:1011's
 *  `{team}/edit` GET+POST combo and `{team}/delete` POST, and web.go:1017-1092's
 *  `/settings` group: the options combo (GET+POST), the avatar write pair,
 *  and the danger-zone POST arms (rename/delete/visibility — upstream's
 *  literal segments; the hooks/applications/labels/packages/actions/
 *  blocked_users/audit_logs tabs are separate pages this wave does not
 *  claim). The `teams` and `settings` second segments claim their shapes
 *  before the repo parse could read them as repositories named "teams"/
 *  "settings" — upstream shadows such repos identically (the org groups
 *  register ahead of :1292's `/{username}/{reponame}`). The team id shapes
 *  claim positive integers only (the org-teams detail precedent — "007"
 *  parses as 7; junk segments stay unclaimed → the engine's 404, upstream's
 *  PathParamInt64-zero ServerError arm). */
export interface OrgSettingsRoute {
  family:
    | "org-settings" // GET+POST /{org}/settings (the options combo)
    | "org-settings-avatar" // POST /{org}/settings/avatar
    | "org-settings-avatar-delete" // POST /{org}/settings/avatar/delete
    | "org-settings-rename" // POST /{org}/settings/rename
    | "org-settings-delete" // POST /{org}/settings/delete
    | "org-settings-visibility" // POST /{org}/settings/visibility
    | "org-settings-hooks" // GET+POST /{org}/settings/hooks (the webhooks list + add form — wave 53)
    | "org-settings-hook-detail" // GET+POST /{org}/settings/hooks/{id} (the edit page — wave 53)
    | "org-settings-hook-delete" // POST /{org}/settings/hooks/{id}/delete (wave 53)
    | "org-settings-blocked" // GET+POST /{org}/settings/blocked_users (window-2b)
    | "org-actions-secrets" // GET+POST /{org}/settings/actions/secrets (window-2b)
    | "org-actions-secrets-delete" // POST .../secrets/delete (window-2b)
    | "org-actions-variables" // GET /{org}/settings/actions/variables (window-2b)
    | "org-actions-variables-new" // POST .../variables/new (window-2b)
    | "org-actions-variables-edit" // POST .../variables/{id}/edit (window-2b)
    | "org-actions-variables-delete" // POST .../variables/{id}/delete (window-2b)
    | "org-team-edit" // GET+POST /{org}/teams/{id}/edit
    | "org-team-delete" // POST /{org}/teams/{id}/delete
  ;
  /** Decoded org segment. */
  owner: string;
  /** The team id (the team-edit/delete families) or hook id (the org
   * hook-detail/delete families — wave 53). */
  id?: number;
}

/** The wave-13 compare family (pages/compare.tsx): upstream's
 *  `m.Get("/compare")` + the `/compare/*` path group (web.go:1307-1315) —
 *  the bare URL (both sides the default branch) and the `{base}...{head}`
 *  tail (FIRST `...` splits; a missing separator makes the whole tail the
 *  head — upstream's single-ref family; an empty side falls back to the
 *  default branch at load). The `..` two-dot family (DirectComparison) and
 *  the `{owner}/{repo}:{head}` fork forms stay UNCLAIMED → the engine's 404
 *  (documented divergences: no landed direct-comparison surface, no forks).
 *  The POST on the same tail is the new-PR write
 *  (CompareAndPullRequestPost — the form lives INLINE on the compare page). */
export interface CompareRoute {
  family: "compare";
  owner: string;
  repo: string;
  /** The base side; `null` = the bare/empty form → the default branch. */
  base: string | null;
  /** The head side; `null` = the bare/empty form → the default branch. */
  head: string | null;
}

/** Top-level single-segment paths this router must never claim: the session
 *  router's literals (registered on the SAME parent app AFTER this sub-app,
 *  so a dynamic `/:owner` registration would shadow them — SPEC-0010 §2.1)
 *  and the dispatcher's own `/healthz`. Upstream reserves several of these
 *  names at create time for the same reason. The wave-7 owner-home family
 *  (user profiles AND org homes share the shape) extends wave 6's label
 *  regex verbatim — it admits every name except these literals. */
const TOP_LEVEL_EXCLUDED = new Set(["login", "logout", "healthz"]);

/** Everything `parseUiRoute` can return; `UiRoute` remains the slice-1 view
 *  render.tsx consumes. */
export type ParsedUiRoute =
  | UiRoute
  | TreeRoute
  | IssuesListRoute
  | IssueDetailRoute
  | IssueNewRoute
  | SettingsRoute
  | IssueCommentRoute
  | IssueLabelsRoute
  | PullFilesRoute
  | PullCommitsRoute
  | PullReviewRoute
  | MilestonesRoute
  | MilestoneNewRoute
  | OwnerHomeRoute
  | UserFeedRoute
  | IssueAuxRoute
  | GlobalInboxRoute
  | WikiRoute
  | FileEditorRoute
  | SiteHomeRoute
  | ExploreRoute
  | NotificationsRoute
  | UserSettingsRoute
  | UserSettingsTabRoute
  | AdminRoute
  | SitemapRoute
  | SearchAuxRoute
  | OrgTeamsRoute
  | OrgLabelsRoute
  | OrgSettingsRoute
  | CompareRoute
  | BranchesRoute
  | CommitViewRoute
  | ReleasesRoute
  | RepoCreateRoute
  | OrgCreateRoute
  | OrgMembersRoute
  | OrgRepositoriesRoute
  | OwnerProjectsRoute
  | OwnerProjectBoardRoute
  | RepoProjectsRoute
  | RepoSocialRoute
  | SettingsCollaborationRoute
  | TagsRoute
  | RepoLabelsRoute
  | MilestoneDetailRoute
  | MilestoneEditRoute
  | RepoForkRoute
  | DiffPatchRoute
  | RepoArchiveRoute
  | CommitContainedRefsRoute
  | BlobRedirectRoute
  | TreeListAuxRoute
  | TreeViewAuxRoute
  | BranchesListAuxRoute
  | ReleaseDownloadRoute
  | RenderFileRoute
  | LastCommitRoute
  | BlobExcerptRoute;


/**
 * Parse a repo-scoped pathname into a UI route, or `null` when the path is
 * not a UI family (→ the dispatcher keeps the engine/gate ownership).
 *
 * Segment handling mirrors `parseGitHttpRoute` (src/git-http/parse.ts):
 * percent-decoding per segment (undecodable → not ours; the engine 404s
 * those), exactly one trailing `.git` trimmed after decoding, and a
 * structural pre-filter — an empty segment anywhere (double slashes,
 * including the never-emitted `//` tails) makes the path not ours.
 */
export function parseUiRoute(pathname: string): ParsedUiRoute | null {
  if (!pathname.startsWith("/")) return null;
  // §4.13: the router 301s trailing-slash URLs to the canonical form; the
  // parser classifies the trimmed shape so the dispatcher admits them.
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const raw = trimmed.split("/");
  // The wave-9 site root (pages/dashboard.tsx — upstream Home): the
  // dashboard for a signed-in viewer, the landing page for anonymous. The
  // trailing-slash form canonicalizes to this shape through the trim above.
  if (raw.length === 1 && raw[0] === "") return { family: "site-home" };
  if (raw.length < 2) return null; // need at least /owner
  if (raw.slice(1).some((segment) => segment === "")) return null;

  // Window-2e: the sitemap literals (pages/sitemap.ts) — EXACT shapes
  // BEFORE the owner/repo parse (else /explore/repos/sitemap-1.xml parses
  // owner=explore). Non-sitemap tails under explore/{repos,users}/ stay
  // unclaimed → the engine's 404.
  if (raw.length === 2 && raw[1] === "sitemap.xml") return { family: "home-sitemap" };
  if (raw.length === 4 && raw[1] === "explore" && (raw[2] === "repos" || raw[2] === "users")) {
    const idx = parseSitemapIdx(raw[3] as string);
    if (idx !== null) {
      return { family: raw[2] === "repos" ? "explore-repos-sitemap" : "explore-users-sitemap", idx };
    }
    return null;
  }

  // The wave-9 explore family (pages/explore.tsx — upstream web.go:549-556):
  // EXACT literal shapes claimed before the owner/repo parse could read
  // `/explore/repos` as a repository. Any other tail (organizations, code,
  // sitemap-*, deeper) stays unclaimed — the engine/parent 404s it, exactly
  // like upstream's unregistered routes. A same-named user namespace
  // (`/EXPLORE`, or `/e%78plore`'s decoded form) keeps the owner-home
  // family — the literals bind case-sensitively, like the chi patterns.
  if (raw[1] === "explore") {
    if (raw.length === 2) return { family: "explore-root" };
    if (raw.length === 3 && raw[2] === "repos") return { family: "explore-repos" };
    if (raw.length === 3 && raw[2] === "users") return { family: "explore-users" };
    // Window-2e: the topic search aux feed (pages/search-aux.ts — upstream
    // explore.TopicSearch, web.go:564, optSignIn).
    if (raw.length === 4 && raw[2] === "topics" && raw[3] === "search") {
      return { family: "explore-topic-search-aux" };
    }
    return null;
  }

  // The wave-10 notifications family (pages/notifications.tsx — upstream
  // web.go:1784-1791): the same exact-literal posture as explore above. The
  // two-segment POST tails MUST be claimed here — the dispatcher consults
  // handlesUiRoute for two-segment paths, and the unclaimed shape would read
  // as an owner/repo pair and fall to the git gate.
  if (raw[1] === "notifications") {
    if (raw.length === 2) return { family: "notifications" };
    if (raw.length === 3 && raw[2] === "new") return { family: "notification-new" };
    if (raw.length === 3 && raw[2] === "status") return { family: "notification-status" };
    if (raw.length === 3 && raw[2] === "purge") return { family: "notification-purge" };
    return null;
  }

  // The wave-12 user settings literal (pages/user-settings.tsx — upstream's
  // reqSignIn /user/settings): claimed before the owner/repo parse could
  // read it as a repository named "settings" under a user named "user" (the
  // notifications precedent; upstream's /user group registers ahead of the
  // dynamic pairs, and "user" is a reserved username besides). Window-2a
  // extends the claim down the tab tails — each shape maps to a committed
  // two-stage module's handoff recipe; every OTHER tail stays unclaimed →
  // the engine's 404 (no landed surface).
  if (raw[1] === "user" && raw[2] === "settings") {
    const tail = raw.slice(3);
    const numericId = (value: string | undefined): number | null =>
      value !== undefined && /^\d+$/.test(value) ? Number.parseInt(value, 10) : null;
    if (tail.length === 0) return { family: "user-settings" };
    if (tail.length === 1 && tail[0] === "appearance") return { family: "user-settings-appearance", id: null };
    if (tail.length === 2 && tail[0] === "appearance" && tail[1] === "theme") {
      return { family: "user-settings-appearance-theme", id: null };
    }
    if (tail.length === 2 && tail[0] === "appearance" && tail[1] === "language") {
      return { family: "user-settings-appearance-language", id: null };
    }
    if (tail.length === 1 && tail[0] === "security") return { family: "user-settings-security", id: null };
    if (tail.length === 2 && tail[0] === "actions" && tail[1] === "secrets") {
      return { family: "user-settings-secrets", id: null };
    }
    if (tail.length === 3 && tail[0] === "actions" && tail[1] === "secrets" && tail[2] === "delete") {
      return { family: "user-settings-secrets-delete", id: null };
    }
    if (tail.length === 2 && tail[0] === "actions" && tail[1] === "variables") {
      return { family: "user-settings-variables", id: null };
    }
    if (tail.length === 3 && tail[0] === "actions" && tail[1] === "variables" && tail[2] === "new") {
      return { family: "user-settings-variables-new", id: null };
    }
    if (tail.length === 4 && tail[0] === "actions" && tail[1] === "variables" && tail[3] === "edit") {
      const id = numericId(tail[2]);
      return id === null ? null : { family: "user-settings-variables-edit", id };
    }
    if (tail.length === 4 && tail[0] === "actions" && tail[1] === "variables" && tail[3] === "delete") {
      const id = numericId(tail[2]);
      return id === null ? null : { family: "user-settings-variables-delete", id };
    }
    if (tail.length === 1 && tail[0] === "hooks") return { family: "user-settings-hooks", id: null };
    if (tail.length === 2) {
      const id = numericId(tail[1]);
      if (id !== null) return { family: "user-settings-hook-detail", id };
    }
    if (tail.length === 3 && tail[2] === "delete") {
      const id = numericId(tail[1]);
      if (id !== null) return { family: "user-settings-hook-delete", id };
    }
    if (tail.length === 1 && tail[0] === "keys") return { family: "user-settings-keys", id: null };
    if (tail.length === 2 && tail[0] === "keys" && tail[1] === "delete") {
      return { family: "user-settings-keys-delete", id: null };
    }
    if (tail.length === 1 && tail[0] === "applications") return { family: "user-settings-applications", id: null };
    if (tail.length === 2 && tail[0] === "applications" && tail[1] === "delete") {
      return { family: "user-settings-applications-delete", id: null };
    }
    // The orgs tab is SINGULAR on the wire (web.go:740 m.Get("/organization",
    // …) serves the plural template — the module's premise correction).
    if (tail.length === 1 && tail[0] === "organization") return { family: "user-settings-organizations", id: null };
    if (tail.length === 2 && tail[0] === "organization" && tail[1] === "leave") {
      return { family: "user-settings-organizations-leave", id: null };
    }
    return null;
  }

  // The wave-19 creation literals (pages/repo-create.tsx + pages/
  // org-create.tsx — upstream's reqSignIn /repo/create + /org/create
  // groups, web.go:1094-1098 + 970-974): the same exact-literal posture as
  // user-settings above. Upstream's /repo and /org groups register ahead of
  // the dynamic pairs too, so a repository named "create" under an owner
  // named "repo" or "org" is shadowed identically (and both names are
  // upstream-reserved at create time besides). Every other /repo|org/*
  // tail stays unclaimed → the engine's 404 (upstream's unregistered-route
  // answer for this slice).
  if (raw.length === 3 && raw[1] === "repo" && raw[2] === "create") {
    return { family: "repo-create" };
  }
  // Window-2e: the repo search aux feed (pages/search-aux.ts — upstream
  // repo.SearchRepo, web.go:1102, reqSignIn): the exact-literal posture
  // beside repo-create.
  if (raw.length === 3 && raw[1] === "repo" && raw[2] === "search") {
    return { family: "repo-search-aux" };
  }
  if (raw.length === 3 && raw[1] === "org" && raw[2] === "create") {
    return { family: "org-create" };
  }

  // Window-2c: the ADMIN literal family (pages/admin-dashboard.tsx +
  // pages/admin-monitor.tsx — upstream's /-/admin group, web.go:779-813,
  // behind verifyAuthWithOptionsWeb(SignInRequired+AdminRequired)): the
  // top-level `/-` namespace is otherwise unclaimed (a repo cannot be named
  // "-"), so the exact shapes claim ahead of the dynamic owner/repo parse.
  // Only the landed pages claim: /-/admin (dashboard GET+POST) and the four
  // monitor pages (+ cron run POST). Every other /-/* tail stays unclaimed
  // → the engine's 404.
  if (raw[1] === "-" && raw[2] === "admin") {
    const tail = raw.slice(3);
    if (tail.length === 0) return { family: "admin-dashboard" };
    if (tail.length === 2 && tail[0] === "monitor") {
      if (tail[1] === "stats") return { family: "admin-monitor", page: "stats" };
      if (tail[1] === "cron") return { family: "admin-monitor", page: "cron" };
      if (tail[1] === "queue") return { family: "admin-monitor", page: "queue" };
      if (tail[1] === "stacktrace") return { family: "admin-monitor", page: "trace" };
    }
    return null;
  }

  // The wave-23 org members family (pages/org-members.tsx — upstream's
  // `/org/{org}/members` literal, web.go:957-961): the exact four-segment
  // shape with the literal `org` first segment and the literal `members`
  // third — the same exact-literal posture as org-create above (upstream's
  // /org group registers ahead of the dynamic pairs, so a repository path
  // /org/{repo}/members is shadowed identically; the "org" owner name is
  // create-time reserved besides). Every other /org/* shape (deeper tails,
  // /org/{org} alone) stays unclaimed → the engine's 404.
  if (raw.length === 4 && raw[1] === "org" && raw[3] === "members") {
    let orgName: string;
    try {
      orgName = decodeURIComponent(raw[2] as string);
    } catch {
      return null;
    }
    return { family: "org-members", owner: orgName };
  }

  let owner: string;
  try {
    owner = decodeURIComponent(raw[1] as string);
  } catch {
    return null;
  }
  // Reserved owner names can never exist in D1 (SPEC-0003 §3); refusing them
  // here keeps `/api/*` and the edge-served `/assets/*` tree engine-owned.
  if (isReservedOwnerName(owner)) return null;

  // The wave-6 single-segment family, wave-7-extended into the owner home
  // (pages/user-profile.tsx beside pages/org-home.tsx): `/{user-or-org}`.
  // The top-level literals stay with their routers (TOP_LEVEL_EXCLUDED), and
  // the `.keys`/`.gpg` suffixes are upstream's early-NotFound suffixes
  // (routers/web/user/home.go:728-735 for users, org/home.go:31-34 for orgs
  // — those upstream routes are not in this slice, so the names stay
  // refused and fall to the parent app's 404).
  if (raw.length === 2) {
    // Window-2e C1: the global inbox pages (pages/global-inbox.tsx —
    // upstream web.go:567-573, reqSignIn): claimed before the owner-home
    // arm could read them as single-segment profiles (upstream's literals
    // register ahead of the dynamic user route; a user named "issues" is
    // create-time reserved besides).
    if (raw[1] === "issues" || raw[1] === "pulls" || raw[1] === "milestones") {
      return { family: raw[1] === "issues" ? "global-issues" : raw[1] === "pulls" ? "global-pulls" : "global-milestones" };
    }
    if (TOP_LEVEL_EXCLUDED.has(owner.toLowerCase())) return null;
    // Window-2e: the feed suffixes (pages/user-feed-xml.ts — upstream
    // UsernameSubRoute's .rss/.atom dispatch, web.go:910-912 → profile.go).
    // The lowercase rule matches the landed .keys/.gpg refusal convention.
    const lowerOwner = owner.toLowerCase();
    if (lowerOwner.endsWith(".rss")) return { family: "user-feed-rss", owner: owner.slice(0, -4) };
    if (lowerOwner.endsWith(".atom")) return { family: "user-feed-atom", owner: owner.slice(0, -5) };
    if (lowerOwner.endsWith(".keys") || lowerOwner.endsWith(".gpg")) return null;
    return { family: "owner-home", owner };
  }

  let repo: string;
  try {
    repo = decodeURIComponent(raw[2] as string);
  } catch {
    return null;
  }
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (repo === "") return null;

  // The wave-12 org teams families (pages/org-teams.tsx — upstream's
  // /{org}/teams group, web.go:993-1013): the literal `teams` second segment
  // claimed before the tail parse could read it as a repository named
  // "teams" (the notifications/explore precedent). Upstream shadows such a
  // repo identically — the org route group registers at web.go:993, ahead
  // of :1292's `/{username}/{reponame}` — so /{user}/teams 404-shells at
  // resolve time exactly like upstream's OrgAssignment miss. The bare URL
  // is the list; `new` the create form (the static literal upstream
  // registers ahead of the {team} param, chi tree order); a positive
  // integer the id-keyed detail slice (the landed /teams/{id} read arms —
  // PathParamInt64 parity, so "007" parses as 7). Wave 49
  // (pages/org-settings.tsx) adds the {id}/edit combo and the {id}/delete
  // write (web.go:1011-1013 — the same positive-integer claim). Every other
  // tail (`/{id}/repositories`, the `/action/*` writes) stays unclaimed →
  // the engine's 404.
  if (repo === "teams") {
    if (raw.length === 3) return { family: "org-teams", owner };
    if (raw.length === 4) {
      if (raw[3] === "new") return { family: "org-team-new", owner };
      if (/^\d+$/.test(raw[3] as string)) {
        return { family: "org-team-detail", owner, id: Number.parseInt(raw[3] as string, 10) };
      }
    }
    if (raw.length === 5 && /^\d+$/.test(raw[3] as string)) {
      if (raw[4] === "edit") return { family: "org-team-edit", owner, id: Number.parseInt(raw[3] as string, 10) };
      if (raw[4] === "delete") return { family: "org-team-delete", owner, id: Number.parseInt(raw[3] as string, 10) };
    }
    return null;
  }

  // The wave-14 org labels families (pages/org-labels.tsx — the brief's
  // literal `/{org}/labels` + upstream's three POST segments): the literal
  // `labels` second segment claimed before the tail parse could read it as a
  // repository named "labels" (the teams precedent; upstream nests the page
  // under /org/{org}/settings/labels and shadows nothing here — pages/
  // org-labels.tsx's divergence note). The `/labels/initialize` template
  // loader and every other tail stay unclaimed → the engine's 404.
  if (repo === "labels") {
    if (raw.length === 3) return { family: "org-labels", owner };
    if (raw.length === 4) {
      if (raw[3] === "new") return { family: "org-label-new", owner };
      if (raw[3] === "edit") return { family: "org-label-edit", owner };
      if (raw[3] === "delete") return { family: "org-label-delete", owner };
    }
    return null;
  }

  // The wave-49 org settings families (pages/org-settings.tsx — upstream's
  // require-owner /{org} group's /settings subtree, web.go:1017-1092): the
  // literal `settings` second segment claimed before the tail parse could
  // read it as a repository named "settings" (the teams/labels precedent;
  // upstream's group registers ahead of :1292 and shadows such a repo
  // identically — a non-owner's miss 404-shells at resolve time, upstream's
  // RequireOwner OrgAssignment NotFound). The `user` first segment is
  // EXCLUDED: upstream's reqSignIn /user group registers ahead of the org
  // groups and owns the whole /user/* namespace (the wave-12 user-settings
  // literal's prefix — /user/settings/* stays the user family's shapes, not
  // an org named "user"). The bare URL is the options combo; the deeper
  // literals are exactly upstream's POST segments (the avatar pair, the
  // danger-zone rename/delete/visibility arms). Wave 53 (pages/
  // org-settings-hooks.tsx) adds the `/hooks` group's shapes — web.go:1033-1044:
  // the bare webhooks list + add-form combo and the {id} edit page (the
  // shared WebHooksEdit; integer-id claim, the repo hooks-family
  // PathParamInt64 parity so "007" parses as 7 and a negative 404-shells on
  // the lookup) + the {id}/delete write (the landed repo page's arm-scoped
  // convention — upstream's shared /delete?id= target is the list trash
  // buttons' form, which this UI does not render). Every other tail (the
  // applications/packages/actions/blocked_users/audit_logs tabs — separate
  // pages not landed) stays unclaimed → the engine's 404.
  if (repo === "settings" && owner.toLowerCase() !== "user") {
    if (raw.length === 3) return { family: "org-settings", owner };
    if (raw.length === 4) {
      if (raw[3] === "avatar") return { family: "org-settings-avatar", owner };
      if (raw[3] === "rename") return { family: "org-settings-rename", owner };
      if (raw[3] === "delete") return { family: "org-settings-delete", owner };
      if (raw[3] === "visibility") return { family: "org-settings-visibility", owner };
      if (raw[3] === "hooks") return { family: "org-settings-hooks", owner };
      // Window-2b: the blocked_users tab (the committed two-stage module);
      // the actions sub-tab tails are claimed below the length-4 block.
      if (raw[3] === "blocked_users") return { family: "org-settings-blocked", owner };
    }
    if (raw.length === 5 && raw[3] === "actions" && raw[4] === "secrets") {
      return { family: "org-actions-secrets", owner };
    }
    if (raw.length === 6 && raw[3] === "actions" && raw[4] === "secrets" && raw[5] === "delete") {
      return { family: "org-actions-secrets-delete", owner };
    }
    if (raw.length === 5 && raw[3] === "actions" && raw[4] === "variables") {
      return { family: "org-actions-variables", owner };
    }
    if (raw.length === 6 && raw[3] === "actions" && raw[4] === "variables" && raw[5] === "new") {
      return { family: "org-actions-variables-new", owner };
    }
    if (raw.length === 7 && raw[3] === "actions" && raw[4] === "variables" && raw[6] === "edit" && /^-?\d+$/.test(raw[5] as string)) {
      return { family: "org-actions-variables-edit", owner, id: Number.parseInt(raw[5] as string, 10) };
    }
    if (raw.length === 7 && raw[3] === "actions" && raw[4] === "variables" && raw[6] === "delete" && /^-?\d+$/.test(raw[5] as string)) {
      return { family: "org-actions-variables-delete", owner, id: Number.parseInt(raw[5] as string, 10) };
    }
    if (raw.length === 5 && raw[3] === "avatar" && raw[4] === "delete") {
      return { family: "org-settings-avatar-delete", owner };
    }
    if (raw.length === 5 && raw[3] === "hooks" && /^-?\d+$/.test(raw[4] as string)) {
      return { family: "org-settings-hook-detail", owner, id: Number.parseInt(raw[4] as string, 10) };
    }
    if (raw.length === 6 && raw[3] === "hooks" && /^-?\d+$/.test(raw[4] as string) && raw[5] === "delete") {
      return { family: "org-settings-hook-delete", owner, id: Number.parseInt(raw[4] as string, 10) };
    }
    return null;
  }

  // The wave-23 org repositories family (pages/org-repos.tsx — upstream's
  // `/{username}/-/repositories`, web.go:1107's `/{username}/-` group's
  // web.go:1134 repositories route): the `-` pseudo-segment namespace claims
  // exactly the repositories tail (a repo cannot be named "-" and no landed
  // family reads the shape, so the claim shadows nothing). Wave 37 adds the
  // sibling bare projects tail (web.go:1143's read group — pages/
  // owner-projects.tsx) and wave 40 the projects board depth + write group
  // (web.go:1140-1155 — pages/owner-project-board.tsx, the board route
  // interface's shape contract). Every other `/-*` tail (`/-/heatmap`,
  // `/-/packages*`, `/-/code`, the bare `/-`) stays unclaimed → the engine's
  // 404, exactly upstream's unregistered-route answer for slices that have
  // not landed.
  if (repo === "-" && raw.length === 4 && raw[3] === "repositories") {
    return { family: "org-repositories", owner };
  }
  if (repo === "-" && raw.length >= 4 && raw[3] === "projects") {
    if (raw.length === 4) return { family: "owner-projects", owner };
    const tail = raw.slice(4);
    const head = tail[0] as string;
    // The write group's `/new` literal (registered ahead of the {id} param
    // upstream — chi static-before-dynamic).
    if (tail.length === 1 && head === "new") return { family: "owner-project-new", owner };
    // The {id} shapes claim positive integers only (the org-teams detail
    // precedent — "007" parses as 7; junk segments stay engine-owned where
    // upstream's PathParamInt64-zero arm would ServerError).
    if (/^\d+$/.test(head)) {
      const id = Number.parseInt(head, 10);
      if (tail.length === 1) return { family: "owner-project-board", owner, id };
      if (tail.length === 2) {
        if (tail[1] === "edit") return { family: "owner-project-edit", owner, id };
        if (tail[1] === "delete") return { family: "owner-project-delete", owner, id };
        if (tail[1] === "open") return { family: "owner-project-status", owner, id, action: "open" };
        if (tail[1] === "close") return { family: "owner-project-status", owner, id, action: "close" };
        if (tail[1] === "workflows") return { family: "owner-project-workflows", owner, id };
      }
      if (tail.length === 3) {
        if (tail[1] === "columns" && tail[2] === "new") {
          return { family: "owner-project-column-new", owner, id };
        }
        if (tail[1] === "workflows" && /^\d+$/.test(tail[2] as string)) {
          return {
            family: "owner-project-workflows",
            owner,
            id,
            workflowId: Number.parseInt(tail[2] as string, 10),
          };
        }
        if (/^\d+$/.test(tail[1] as string) && tail[2] === "default") {
          return {
            family: "owner-project-column-default",
            owner,
            id,
            columnId: Number.parseInt(tail[1] as string, 10),
          };
        }
      }
      if (
        tail.length === 4 &&
        tail[1] === "workflows" &&
        /^\d+$/.test(tail[2] as string) &&
        tail[3] === "delete"
      ) {
        return {
          family: "owner-project-workflow-delete",
          owner,
          id,
          workflowId: Number.parseInt(tail[2] as string, 10),
        };
      }
    }
    return null;
  }

  const tail = raw.slice(3);
  if (tail.length === 0) return { family: "home", owner, repo, refSuffix: null };

  // Family literals are lowercase-exact, like upstream's chi patterns
  // (`{type:branch|tag|commit}` routes; `gitea/routers/web/web.go:1749`).
  const [head, ...rest] = tail;
  // Wave-2 families: /tree re-emits its suffix RAW (RedirectRepoTreeToSrc
  // swaps the still-encoded text, view_home.go:521). /issues and /pulls
  // claim the bare list URLs plus the wave-3 single-integer detail tail
  // (upstream chi `/{index}` + PathParamInt64: "007" is 7, a negative is
  // admitted here and 404-shells on the row lookup) and — wave 4 — the
  // `/issues/new` form (the family literal wins before the integer shape
  // could, and the POST carries no family of its own). Anything else in the
  // space (`/issues/1/comments`, non-numeric) stays engine-owned, the same
  // posture as `/commit/{sha}` (§1.2, open question 1). `/settings` claims
  // the bare basics URL and the `/settings/hooks` sub-page (wave 4); the
  // deeper settings space stays engine-owned.
  if (head === "tree") return { family: "tree", owner, repo, rawSuffix: rest.join("/") };
  // Wave-39: the blob-redirect twin of the tree arm (upstream
  // RedirectRepoBlobToCommit, view_home.go:528-536 — the still-encoded
  // suffix re-emitted onto /src/commit/; the bare /blob claims the shape and
  // 404-shells at the dispatcher, the tree family's arm).
  if (head === "blob") return { family: "blob-redirect", owner, repo, rawSuffix: rest.join("/") };
  // Wave-39: the find-file aux family (upstream web.go:1297-1306's three
  // typed sub-routes over repo.TreeList). The type literal is the route
  // shape — chi registers exactly branch/tag/commit, so any other segment
  // and the bare/below-minimum tails (chi's `/*` needs the typed tail) stay
  // engine-owned; the decoded tail is the /src family's ref+path shape (the
  // handler resolves only the ref half — the module doc).
  if (head === "tree-list") {
    const typed = rest[0];
    if (rest.length < 2 || (typed !== "branch" && typed !== "tag" && typed !== "commit")) return null;
    try {
      return {
        family: "tree-list-aux",
        owner,
        repo,
        refType: typed,
        refSuffix: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
      };
    } catch {
      return null;
    }
  }
  // Wave-43: the tree-view envelope family (upstream web.go:1302-1306's
  // three typed sub-routes over repo.TreeViewNodes — the tree-list twin's
  // shape). The type literal is the route shape — chi registers exactly
  // branch/tag/commit, so any other segment and the bare/below-minimum
  // tails stay engine-owned; the decoded tail is the /src family's ref+path
  // shape (both halves are load-bearing here — the walk roots at the path
  // half; `?sub_path=` rides the query, the handler reads it).
  if (head === "tree-view") {
    const typed = rest[0];
    if (rest.length < 2 || (typed !== "branch" && typed !== "tag" && typed !== "commit")) return null;
    try {
      return {
        family: "tree-view-aux",
        owner,
        repo,
        refType: typed,
        refSuffix: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
      };
    } catch {
      return null;
    }
  }
  // Wave-46: the lastcommit fragment family (upstream web.go:1761's
  // `m.Get("/lastcommit/*", RepoRefByType(RefTypeCommit), repo.LastCommit)`).
  // The wildcard claims the bare URL too (chi's `*` matches the empty tail —
  // the archive family's precedent), which upstream answers with the DEFAULT
  // BRANCH's root listing; the landed commit-arm convention declines that
  // default-branch swap (the module doc's HEAD note), so the bare tail rides
  // the family and 404-shells at the handler (parseLastCommitTail's miss).
  // The tail decodes per segment (parseLastCommitTail's input contract); an
  // undecodable segment is not ours (the parse prefilter's posture).
  if (head === "lastcommit") {
    try {
      return { family: "lastcommit", owner, repo, rawTail: rest.map((segment) => decodeURIComponent(segment)).join("/") };
    } catch {
      return null;
    }
  }
  // Wave-46: the blob-excerpt fragment families (upstream web.go:1735's
  // repo twin + web.go:1618's wiki twin over repo.ExcerptBlob). The `{sha}`
  // param is a plain chi single segment (no hex shape — the handler's
  // GetCommit miss is the 404 family), so the claims are the exact
  // 3-segment (repo) and 5-segment (wiki) shapes; deeper or shorter tails
  // stay unclaimed → the engine's 404, exactly upstream's unregistered-route
  // answer.
  if (head === "blob_excerpt") {
    if (rest.length !== 1) return null;
    try {
      return { family: "blob-excerpt", owner, repo, sha: decodeURIComponent(rest[0] as string) };
    } catch {
      return null;
    }
  }
  if (head === "wiki") {
    if (rest.length !== 2 || rest[0] !== "blob_excerpt") return null;
    try {
      return { family: "wiki-blob-excerpt", owner, repo, sha: decodeURIComponent(rest[1] as string) };
    } catch {
      return null;
    }
  }
  // Window-2e B2: the activity-author JSON feed (web.go:1683-1687 — the
  // optional period tail; unknown/bare segments hit the WEEKLY default).
  if (head === "activity_author_data") {
    if (rest.length === 0) return { family: "activity-author-data", owner, repo };
    if (rest.length === 1) return { family: "activity-author-data", owner, repo, segment: rest[0] };
  }

  if (head === "issues" || head === "pulls") {
    if (rest.length === 0) return { family: head, owner, repo };
    if (rest.length === 1) {
      if (head === "issues" && rest[0] === "new") return { family: "issue-new", owner, repo };
      // Wave-5: the sidebar label-write POST (upstream data-update-url).
      if (head === "issues" && rest[0] === "labels") return { family: "issue-labels", owner, repo };
      // Wave-11: the review-request + dismiss POSTs (web.go:1435-1436 —
      // repo-scoped, the issue/review ids ride the form fields).
      if (head === "issues" && rest[0] === "request_review") return { family: "issue-request-review", owner, repo };
      if (head === "issues" && rest[0] === "dismiss_review") return { family: "issue-dismiss-review", owner, repo };
      // Window-2e B2: the aux feeds (upstream web.go:1341/1359 — the
      // suggestions route sits in the labels/milestones sibling group).
      if (head === "issues" && rest[0] === "search") return { family: "issues-search-aux", owner, repo };
      if (head === "issues" && rest[0] === "suggestions") return { family: "issues-suggestions-aux", owner, repo };
      if (/^-?\d+$/.test(rest[0] as string)) {
        return { family: "issue-detail", owner, repo, urlKind: head, index: Number.parseInt(rest[0] as string, 10) };
      }
    }
    // Wave-5: the comment write + the PR files view, under BOTH families'
    // index tails (upstream hangs /comments on `/{type:issues|pulls}/{index}`
    // — web.go:1376 — and /files on the pulls group only — web.go:1670).
    if (rest.length === 2 && /^-?\d+$/.test(rest[0] as string)) {
      const index = Number.parseInt(rest[0] as string, 10);
      if (rest[1] === "comments") return { family: "issue-comment", owner, repo, urlKind: head, index };
      if (head === "pulls" && rest[1] === "files") return { family: "pull-files", owner, repo, index };
      if (head === "pulls" && rest[1] === "commits") return { family: "pull-commits", owner, repo, index };
      // Window-2e B2: the info/attachments fragments (web.go:1321-1334,
      // both families) + the merge box (web.go:1659, pulls).
      if (rest[1] === "info") return { family: "issue-info", owner, repo, urlKind: head, index };
      if (rest[1] === "attachments") return { family: "issue-attachments", owner, repo, urlKind: head, index };
      if (head === "pulls" && rest[1] === "merge_box") return { family: "pull-merge-box", owner, repo, index };
    }
    if (rest.length === 3 && /^-?\d+$/.test(rest[0] as string)) {
      const index = Number.parseInt(rest[0] as string, 10);
      // The content-history overview fragment (list/detail stay unclaimed —
      // no snapshot store).
      if (rest[1] === "content-history" && rest[2] === "overview") {
        return { family: "issue-content-overview", owner, repo, urlKind: head, index };
      }
      // The byte-serving alias: upstream mounts the uuid arm at
      // /{index}/attachments/{uuid} (web.go:1337) driving the same seam as
      // the site-level /attachments/{uuid} — a 302 onto it (the module's
      // handoff).
      if (rest[1] === "attachments" && rest[2] !== undefined && rest[2] !== "") {
        return { family: "issue-attachments-alias", owner, repo, urlKind: head, index, segment: rest[2] };
      }
      // The committed-range files page (web.go:1672) and the single-commit
      // page AT UPSTREAM'S PATH /pulls/{index}/commits/{sha} (web.go:1663 —
      // the /files/{sha} tail is upstream's pattern miss; the b48757e
      // divergence honored).
      if (head === "pulls" && rest[1] === "files" && parsePullFilesRange(rest[2] as string) !== null) {
        return { family: "pull-files-range", owner, repo, index, segment: rest[2] };
      }
      if (head === "pulls" && rest[1] === "commits" && parsePullFilesSingleCommit(rest[2] as string) !== null) {
        return { family: "pull-commit-files", owner, repo, index, segment: rest[2] };
      }
    }
    // Wave-11: the review verdict form POST (web.go:1678 — the
    // /pulls/{index}/files/reviews group's /submit tail; the GET new_comment
    // + POST comments code-comment siblings stay unclaimed, no landed UI).
    if (
      head === "pulls" &&
      rest.length === 4 &&
      /^-?\d+$/.test(rest[0] as string) &&
      rest[1] === "files" &&
      rest[2] === "reviews" &&
      rest[3] === "submit"
    ) {
      return { family: "pull-review-submit", owner, repo, index: Number.parseInt(rest[0] as string, 10) };
    }
    // Wave-29 (the survey's row 4): the raw-text download tails
    // `/{index}.{diff|patch}` — upstream web.go:1657-1658's pair under the
    // pulls group. Positive integers exactly (the landed API seam's
    // `^(\d+)\.(diff|patch)$` convention; a negative or junk index 404s in
    // upstream too — chi's PathParamInt64 miss — and stays engine-owned
    // here, the unregistered-route answer).
    if (head === "pulls" && rest.length === 1) {
      const dotted = /^(\d+)\.(diff|patch)$/.exec(rest[0] as string);
      if (dotted !== null) {
        return {
          family: "pull-diffpatch",
          owner,
          repo,
          index: Number.parseInt(dotted[1] as string, 10),
          ext: dotted[2] as "diff" | "patch",
        };
      }
    }
    return null;
  }
  if (head === "settings") {
    if (rest.length === 0) return { family: "settings", owner, repo };
    if (rest.length === 1 && rest[0] === "hooks") return { family: "settings-hooks", owner, repo };
    // Window-2d: the four settings-tab modules. The githooks group claims
    // BEFORE the numeric hooks/{id} block could matter ("git" fails the
    // numeric guard — explicit claims keep both owners unambiguous).
    if (rest.length === 2 && rest[0] === "hooks" && rest[1] === "git") {
      return { family: "settings-githooks", owner, repo };
    }
    if (rest.length === 3 && rest[0] === "hooks" && rest[1] === "git" && rest[2] !== undefined && rest[2] !== "") {
      return { family: "settings-githook", owner, repo, name: decodeURIComponent(rest[2]) };
    }
    if (rest.length === 1 && rest[0] === "tags") return { family: "settings-tags", owner, repo };
    if (rest.length === 2 && rest[0] === "tags" && rest[1] === "delete") {
      return { family: "settings-tags-delete", owner, repo };
    }
    if (rest.length === 2 && rest[0] === "tags" && /^-?\d+$/.test(rest[1] as string)) {
      return { family: "settings-tag-detail", owner, repo, id: Number.parseInt(rest[1] as string, 10) };
    }
    if (rest.length === 1 && rest[0] === "keys") return { family: "settings-keys", owner, repo };
    if (rest.length === 2 && rest[0] === "keys" && rest[1] === "delete") {
      return { family: "settings-keys-delete", owner, repo };
    }
    if (rest.length === 1 && rest[0] === "public_access") {
      return { family: "settings-public-access", owner, repo };
    }
    // Window-2d pass 2: the wiki-config arm (options.tmpl's pieces).
    if (rest.length === 1 && rest[0] === "wiki") return { family: "settings-wiki", owner, repo };
    // Wave 10: the mirror panel (the brief's literal URL; upstream renders
    // the section on options.tmpl — pages/settings.tsx's divergence note).
    if (rest.length === 1 && rest[0] === "mirror") return { family: "settings-mirror", owner, repo };
    // Wave 14: the per-hook page + its two POST tails (upstream's
    // /settings/hooks/{id} WebHooksEdit + /{id}/test TestWebhook; the delete
    // rides the arm-scoped tail — upstream's shared /delete?id= form target
    // exists for the list trash buttons this UI does not render;
    // pages/settings.tsx's wave-14 header). PathParamInt64 parity: "007"
    // parses as 7, a negative is admitted here and 404-shells on the lookup
    // (the issue-detail convention). Any other tail (/settings/hooks/abc,
    // /{id}/edit, deeper) stays engine-owned — upstream has no such routes.
    if (rest.length >= 2 && rest[0] === "hooks" && /^-?\d+$/.test(rest[1] as string)) {
      const id = Number.parseInt(rest[1] as string, 10);
      if (rest.length === 2) return { family: "settings-hook-detail", owner, repo, id };
      if (rest.length === 3 && rest[2] === "test") return { family: "settings-hook-test", owner, repo, id };
      if (rest.length === 3 && rest[2] === "delete") return { family: "settings-hook-delete", owner, repo, id };
    }
    // Wave 15: the protected-branches family (pages/branch-protection.tsx —
    // upstream's literal group, web.go:1206-1212): the list, the shared
    // create/edit form at the `/edit` literal (the GET keyed by
    // `?rule_name=`, the POST by the hidden rule_id), the priority reorder
    // POST (upstream's JS sends the {ids} JSON; our no-JS form posts the
    // urlencoded repeated ids — pages/branch-protection.tsx's header), and
    // the id-keyed delete POST (PathParamInt64 parity, the hook-id
    // convention). Every deeper/junk tail (/branches/abc, /{id}/edit,
    // /edit/more) stays engine-owned.
    if (rest.length === 1 && rest[0] === "branches") return { family: "settings-branches", owner, repo };
    if (rest.length === 2 && rest[0] === "branches" && rest[1] === "edit") return { family: "settings-branch-edit", owner, repo };
    if (rest.length === 2 && rest[0] === "branches" && rest[1] === "priority") return { family: "settings-branch-priority", owner, repo };
    if (rest.length === 3 && rest[0] === "branches" && /^-?\d+$/.test(rest[1] as string) && rest[2] === "delete") {
      return { family: "settings-branch-delete", owner, repo, id: Number.parseInt(rest[1] as string, 10) };
    }
    // Wave 24: the collaboration panel + its four POST-only write tails
    // (pages/settings-collaboration.tsx — upstream web.go:1194-1204's
    // group): the `m.Combo("")` page (GET + POST the add-collaborator
    // write) and upstream's exact literal tails — /access_mode, /delete,
    // /team and /team/delete (the ids ride the form fields, upstream's
    // FormInt64 carriers, so no id appears in any pattern). Every other
    // /collaboration/* tail stays engine-owned.
    if (rest.length === 1 && rest[0] === "collaboration") return { family: "settings-collaboration", owner, repo };
    if (rest.length === 2 && rest[0] === "collaboration") {
      if (rest[1] === "access_mode") return { family: "settings-collab-access-mode", owner, repo };
      if (rest[1] === "delete") return { family: "settings-collab-delete", owner, repo };
      if (rest[1] === "team") return { family: "settings-collab-team-add", owner, repo };
    }
    if (rest.length === 3 && rest[0] === "collaboration" && rest[1] === "team" && rest[2] === "delete") {
      return { family: "settings-collab-team-delete", owner, repo };
    }
    return null;
  }
  // Wave-6: the milestones list (the bare URL, `?state=` carries the facet)
  // and the `/milestones/new` form (GET + POST). Wave 26 adds the `{id}/edit`
  // combo (upstream web.go:1427-1428 — the id segment decodes verbatim, the
  // loader validates it). The remaining write tails (`/{id}/{action}` close/
  // open, `/delete`) stay engine-owned — this slice renders no controls for
  // them (the dead-link rule), exactly upstream's unregistered-route answer
  // for shapes its router does claim but the slice does not.
  if (head === "milestones") {
    if (rest.length === 0) return { family: "milestones", owner, repo };
    if (rest.length === 1 && rest[0] === "new") return { family: "milestone-new", owner, repo };
    if (rest.length === 2 && rest[1] === "edit") {
      let id: string;
      try {
        id = decodeURIComponent(rest[0] as string);
      } catch {
        return null;
      }
      return { family: "milestone-edit", owner, repo, id };
    }
    return null;
  }
  // Wave-26 milestone detail (pages/milestone-detail.tsx — upstream
  // web.go:1340's SINGULAR `/milestone/{id}` route, the survey's TOP-3 row):
  // the exact single-segment tail claimed for ANY segment value so a
  // non-numeric id 404-shells through the loader (the commit-view sha
  // convention) instead of reaching the engine. Deeper tails stay
  // engine-owned; the bare `/milestone` falls through to the engine's 404 —
  // upstream has no such route.
  if (head === "milestone") {
    if (rest.length !== 1) return null;
    let id: string;
    try {
      id = decodeURIComponent(rest[0] as string);
    } catch {
      return null;
    }
    return { family: "milestone-detail", owner, repo, id };
  }
  // Wave-13: the compare family (pages/compare.tsx — upstream web.go:1307-
  // 1315). The bare URL and the `{base}...{head}` tail (FIRST `...` splits
  // the decoded suffix — strings.Cut parity; refnames can never carry `..`,
  // so the separator is unambiguous and the emitted links always re-parse to
  // the same pair). A missing separator makes the whole tail the HEAD
  // (upstream's single-ref family); an empty side is the default-branch
  // fallback (the loader's util.IfZero arm). The `..` two-dot family
  // (DirectComparison — a different diff semantic, not a landed surface) and
  // the `{owner}/{repo}:{head}` fork forms (colon-bearing sides; forks
  // cannot exist yet, SPEC-0003) stay unclaimed → the engine's 404, exactly
  // upstream's unregistered-route answer for this slice.
  if (head === "wiki") {
    // Window-2e C2: the WIKI family (pages/repo-wiki.tsx — upstream
    // web.go:1611-1617's two combos; the SUB-PAGES dispatch on the
    // ?action= FORM VALUE inside the handlers, not the path — the module's
    // verified grammar). The raw/* byte arm stays unclaimed (the module
    // ported the five template pages only) → the engine's 404.
    let rawTail: string;
    try {
      rawTail = rest.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return null;
    }
    return { family: "wiki", owner, repo, rawTail };
  }
  if (head === "compare") {
    if (rest.length === 0) return { family: "compare", owner, repo, base: null, head: null };
    let suffix: string;
    try {
      suffix = rest.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return null;
    }
    if (suffix === "") return { family: "compare", owner, repo, base: null, head: null };
    // Window-2e B2: the .diff/.patch byte feeds (web.go:1309-1310) — claim
    // the suffixed tails BEFORE the page family returns (they would
    // otherwise fall into the single-ref family and 404 at resolution).
    if (suffix.endsWith(".diff")) {
      return { family: "compare-feed", owner, repo, ext: "diff", segment: suffix.slice(0, -5) };
    }
    if (suffix.endsWith(".patch")) {
      return { family: "compare-feed", owner, repo, ext: "patch", segment: suffix.slice(0, -6) };
    }
    const separator = suffix.indexOf("...");
    if (separator < 0) {
      if (suffix.includes("..") || suffix.includes(":")) return null;
      return { family: "compare", owner, repo, base: null, head: suffix };
    }
    const base = suffix.slice(0, separator);
    const headSide = suffix.slice(separator + 3);
    if (base.includes("..") || base.includes(":") || headSide.includes("..") || headSide.includes(":")) return null;
    return {
      family: "compare",
      owner,
      repo,
      base: base === "" ? null : base,
      head: headSide === "" ? null : headSide,
    };
  }
  // Wave-16 branches family (pages/branches.tsx — upstream web.go:1478-1482's
  // group): the bare URL is the list; the `/delete` tail is the POST-only
  // write (the branch name rides the form field). Wave 39 lifts the group's
  // sibling `/list` literal out of the unclaimed set (web.go:1695 — the
  // branches aux JSON, pages/branches-list-aux.ts). Every other tail
  // (`/branches/abc`, upstream's `/_new/*` create + `/restore` writes, which
  // have no landed flows) stays engine-owned → the engine's 404.
  if (head === "branches") {
    if (rest.length === 0) return { family: "branches", owner, repo };
    if (rest.length === 1 && rest[0] === "delete") return { family: "branch-delete", owner, repo };
    if (rest.length === 1 && rest[0] === "list") return { family: "branches-list-aux", owner, repo };
    return null;
  }
  // Wave-20 releases family (pages/releases.tsx — upstream web.go:1505-1514's
  // group, the parity survey's #4): the bare URL is the list, `/new` the
  // create form + write, `/latest` the redirect, `/tag/{tail}` the single-
  // release page — the tail is the DECODED tag name with slashes preserved
  // (chi's `*` param; refnames carry slashes, so the emitted
  // `/releases/tag/v1.0/rc` links re-parse to the same route). Wave 33 (the
  // survey's top-5 #4) lifts the write group's `/edit/{tail}` (the same
  // wildcard decode — the URL-keyed tag) and `/delete` literals out of the
  // unclaimed set (web.go:1519-1520 + 1523). Wave 41 lifts the group's two
  // GET download routes out of the unclaimed set (web.go:1513-1514 — the
  // download-tail families below). The feed tails upstream registers
  // (`.rss`/`.atom`), the `/generate-notes` and the `/attachments`+
  // `/attachments/remove` POST write tails stay unclaimed → the engine's 404.
  if (head === "releases") {
    if (rest.length === 0) return { family: "releases", owner, repo };
    if (rest.length === 1 && rest[0] === "new") return { family: "release-new", owner, repo };
    if (rest.length === 1 && rest[0] === "latest") return { family: "release-latest", owner, repo };
    if (rest.length === 1 && rest[0] === "delete") return { family: "release-delete", owner, repo };
    if (rest.length >= 2 && rest[0] === "edit") {
      try {
        return {
          family: "release-edit",
          owner,
          repo,
          tag: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
        };
      } catch {
        return null;
      }
    }
    if (rest.length >= 2 && rest[0] === "tag") {
      try {
        return {
          family: "release-detail",
          owner,
          repo,
          tag: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
        };
      } catch {
        return null;
      }
    }
    // Wave-41 download tail (pages/release-downloads.ts — upstream
    // web.go:1513-1514's two GETs, the parity survey's top-5 #1): the
    // `/attachments/{uuid}` serve and the `/download/{vTag}/{fileName}`
    // redirect arm. BOTH are chi SINGLE-segment params (no wildcard — a
    // literal slash in the file name 404s upstream), so the claims are the
    // exact 3- and 4-segment shapes and every deeper tail stays unclaimed →
    // the engine's 404.
    if (rest.length === 2 && rest[0] === "attachments") {
      try {
        return { family: "release-attachment", owner, repo, uuid: decodeURIComponent(rest[1] as string) };
      } catch {
        return null;
      }
    }
    if (rest.length === 3 && rest[0] === "download") {
      try {
        return {
          family: "release-download",
          owner,
          repo,
          vTag: decodeURIComponent(rest[1] as string),
          fileName: decodeURIComponent(rest[2] as string),
        };
      } catch {
        return null;
      }
    }
    return null;
  }
  // Wave-41 rendered blob views (pages/render-files.ts — upstream
  // web.go:1715-1719's `/render` group, the survey's row 3): the three typed
  // ref sub-routes are the /src family's shape (the decoded ref+path suffix
  // over the SAME resolveRefSuffix universes, RepoRefByType's arms), the
  // `/blob/{sha}` arm is the exact 2-segment shape. A bare `/render`, an
  // unknown type literal, or deeper tails stay unclaimed → the engine's 404,
  // exactly upstream's unregistered-route answer.
  if (head === "render") {
    if (rest.length === 2 && rest[0] === "blob") {
      try {
        return { family: "render-file", owner, repo, sha: decodeURIComponent(rest[1] as string) };
      } catch {
        return null;
      }
    }
    if (rest.length >= 2 && (rest[0] === "branch" || rest[0] === "tag" || rest[0] === "commit")) {
      try {
        return {
          family: "render-file",
          owner,
          repo,
          refType: rest[0],
          refSuffix: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
        };
      } catch {
        return null;
      }
    }
    return null;
  }
  // Wave-24 repo social lists (pages/repo-social.tsx — upstream's three bare
  // repo-scoped literals, web.go:1759 /forks + web.go:1766 /stars +
  // web.go:1767 /watchers, the survey bench's third-ranked row): exact
  // single-literal shapes, GET-only. Any deeper tail stays unclaimed → the
  // engine's 404, exactly upstream's unregistered-route answer. (The
  // singular `/fork` combo below is wave 26's — a distinct literal.)
  if (head === "forks" || head === "stars" || head === "watchers") {
    if (rest.length === 0) return { family: head, owner, repo };
    return null;
  }
  // Wave-26 fork form (pages/repo-fork.tsx — upstream web.go:1490's
  // `m.Combo("/fork").Get(repo.Fork).Post(...)`, the survey's TOP-5 row):
  // the exact bare literal, GET the form + POST the landed createFork
  // sequence (the signed-in gate and the empty-source 404 run at the
  // handlers, upstream reqSignIn + getForkRepository's IsEmpty arm). Deeper
  // tails stay unclaimed → the engine's 404.
  if (head === "fork") {
    if (rest.length === 0) return { family: "repo-fork", owner, repo };
    return null;
  }
  // Wave-25 tags family (pages/tags.tsx — upstream web.go:1493-1496's
  // `/tags` group's list route, the survey's TOP-1 row): the exact bare
  // literal. Wave 33 (the survey's top-5 #2) lifts the group's other two
  // routes out of the unclaimed set: `/tags/list` the aux JSON (web.go:1499,
  // pages/tag-list-aux.ts) and `/tags/delete` the delete write (web.go:1501,
  // POST-only — GET answers chi's 405). The `.rss`/`.atom` feed tails and
  // every deeper tail stay unclaimed → the engine's 404, exactly upstream's
  // unregistered-route answer.
  if (head === "tags") {
    if (rest.length === 0) return { family: "tags", owner, repo };
    if (rest.length === 1 && rest[0] === "list") return { family: "tags-list-aux", owner, repo };
    if (rest.length === 1 && rest[0] === "delete") return { family: "tags-delete", owner, repo };
    return null;
  }
  // Wave-25 repo labels families (pages/repo-labels.tsx — upstream
  // web.go:1338's page + web.go:1417-1422's three POST segments, the
  // survey's TOP-2 row): the bare literal is the list; the write tails are
  // upstream's exact segments (the write gate runs at the handlers). The
  // third-segment position never collides with the wave-14 org literal
  // (that one claims `labels` as the SECOND segment, shadowing a repository
  // named "labels" exactly like upstream's own route order). The
  // `/labels/initialize` template loader and every deeper tail stay
  // unclaimed → the engine's 404.
  if (head === "labels") {
    if (rest.length === 0) return { family: "repo-labels", owner, repo };
    if (rest.length === 1) {
      if (rest[0] === "new") return { family: "repo-label-new", owner, repo };
      if (rest[0] === "edit") return { family: "repo-label-edit", owner, repo };
      if (rest[0] === "delete") return { family: "repo-label-delete", owner, repo };
    }
    return null;
  }
  // Wave-45 repo projects families (pages/repo-projects.tsx — upstream
  // web.go:1544-1563's group, the survey's re-ranked #1; the wave-40 flip
  // kept these repo-scoped shapes unclaimed until this wave): the bare
  // literal is the list; `/new` the write group's form combo (registered
  // ahead of the {id} param upstream — chi static-before-dynamic); the {id}
  // shapes claim positive integers only (the owner-board families'
  // PathParamInt64 parity — "007" parses as 7; junk segments stay
  // engine-owned where upstream's PathParamInt64-zero arm would
  // ServerError). The PUT/DELETE board-helper arms (`/{columnID}`) and the
  // drag-drop JSON arms (`/move`, `/{columnID}/move`) stay unclaimed → the
  // engine's 404; every deeper tail likewise.
  if (head === "projects") {
    if (rest.length === 0) return { family: "repo-projects", owner, repo };
    if (rest.length === 1 && rest[0] === "new") return { family: "repo-project-new", owner, repo };
    if (/^\d+$/.test(rest[0] as string)) {
      const id = Number.parseInt(rest[0] as string, 10);
      if (rest.length === 1) return { family: "repo-project-board", owner, repo, id };
      if (rest.length === 2) {
        if (rest[1] === "edit") return { family: "repo-project-edit", owner, repo, id };
        if (rest[1] === "delete") return { family: "repo-project-delete", owner, repo, id };
        if (rest[1] === "open") return { family: "repo-project-status", owner, repo, id, action: "open" };
        if (rest[1] === "close") return { family: "repo-project-status", owner, repo, id, action: "close" };
        if (rest[1] === "workflows") return { family: "repo-project-workflows", owner, repo, id };
      }
      if (rest.length === 3) {
        if (rest[1] === "columns" && rest[2] === "new") {
          return { family: "repo-project-column-new", owner, repo, id };
        }
        if (rest[1] === "workflows" && /^\d+$/.test(rest[2] as string)) {
          return {
            family: "repo-project-workflows",
            owner,
            repo,
            id,
            workflowId: Number.parseInt(rest[2] as string, 10),
          };
        }
        if (/^\d+$/.test(rest[1] as string) && rest[2] === "default") {
          return {
            family: "repo-project-column-default",
            owner,
            repo,
            id,
            columnId: Number.parseInt(rest[1] as string, 10),
          };
        }
      }
      if (
        rest.length === 4 &&
        rest[1] === "workflows" &&
        /^\d+$/.test(rest[2] as string) &&
        rest[3] === "delete"
      ) {
        return {
          family: "repo-project-workflow-delete",
          owner,
          repo,
          id,
          workflowId: Number.parseInt(rest[2] as string, 10),
        };
      }
    }
    return null;
  }
  // Wave-18 commit view (pages/commit-view.tsx — upstream web.go:1739): the
  // exact single-segment tail only, claimed for ANY segment value so a
  // non-hex sha 404-shells through the loader (the brief's rule) instead of
  // reaching the engine. Deeper tails are lifted by their own wave families
  // (the `.{patch|diff}` downloads below, wave-32's `/load-branches-and-
  // tags` aux JSON); junk stays engine-owned, and the bare `/commit` falls
  // through to the engine's 404 — upstream's own shape.
  if (head === "commit") {
    if (rest.length !== 1 && rest.length !== 2) return null;
    let sha: string;
    try {
      sha = decodeURIComponent(rest[0] as string);
    } catch {
      return null;
    }
    // Wave-32 (the survey's row 3): the aux-JSON tail `/load-branches-and-
    // tags` — upstream web.go:1740's
    // `{sha:([a-f0-9]{7,64})}/load-branches-and-tags` route lifts the
    // HEX-shaped 5-segment shape out of the view family (the case folding
    // is the landed COMMIT_SHA convention; a non-hex sha with the literal
    // tail is upstream's pattern miss → engine-owned; the loader re-gates
    // the shape).
    if (rest.length === 2) {
      if (rest[1] !== "load-branches-and-tags" || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
      return { family: "commit-contained-refs", owner, repo, sha };
    }
    // Wave-29 (the survey's row 4): the raw-text download tails
    // `{sha}.{diff|patch}` — upstream web.go:1760's
    // `{sha:([a-f0-9]{7,64})}.{ext:patch|diff}` route lifts the hex-shaped
    // dotted segment into the download family (the case folding is the
    // landed COMMIT_SHA convention); every other segment keeps the wave-18
    // commit-view claim (a non-hex `foo.diff` 404-shells there, upstream's
    // pattern-miss answer).
    const dotted = /^([0-9a-f]{7,64})\.(diff|patch)$/i.exec(sha);
    if (dotted !== null) {
      return {
        family: "commit-diffpatch",
        owner,
        repo,
        sha: dotted[1] as string,
        ext: dotted[2] as "diff" | "patch",
      };
    }
    return { family: "commit-view", owner, repo, sha };
  }
  // Wave-32 archive download (pages/archive-files.ts — upstream web.go:1689):
  // the `/archive/*` wildcard claims every tail INCLUDING the bare URL (chi's
  // `/*` matches the empty tail and `SplitArchiveNameType("")` is the route's
  // 400 arm — the loader's bad-format answer). The tail is the DECODED
  // `{ref}.{zip|tar.gz}` with slashes preserved (multi-segment ref names
  // re-parse to the same route, the release-detail tag convention); the
  // format/ref gates run at the loader. The POST half (InitiateDownload,
  // web.go:1690) stays engine-owned — GET only, the survey's page-bearing
  // rule.
  if (head === "archive") {
    let refExt: string;
    try {
      refExt = rest.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return null;
    }
    return { family: "repo-archive", owner, repo, refExt };
  }
  // Wave-8 file editor: the `new`/`edit`/`delete` literals claim the
  // branch+path tail shape (FileEditorRoute). Bare literals fall through to
  // the engine (upstream chi requires the `/*` tail as well).
  if (head === "new" || head === "edit" || head === "delete") {
    if (rest.length === 0) return null;
    let suffix: string;
    try {
      suffix = rest.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return null;
    }
    return {
      family: head === "new" ? "file-new" : head === "edit" ? "file-edit" : "file-delete",
      owner,
      repo,
      refSuffix: suffix,
    };
  }
  let suffix: string;
  try {
    suffix = rest.map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    return null;
  }
  if (head === "commits") return { family: "commits", owner, repo, refSuffix: rest.length > 0 ? suffix : null };
  if (head === "src") return { family: "src", owner, repo, refSuffix: rest.length > 0 ? suffix : null };
  return null;
}

/** The dispatcher gate (§2.2): `true` = the request belongs to a UI page
 *  family and must be answered by `uiRouter`, never the engine. */
export function handlesUiRoute(pathname: string): boolean {
  return parseUiRoute(pathname) !== null;
}

// ---------------------------------------------------------------------------
// Ref-suffix resolution (§3.3) — upstream's URL-path ref rules, ported
// from `RepoRefByType`/`getRefName` (gitea/services/context/repo.go:833-935).
// Pure functions: U3's page-data layer supplies `listRefs()` output.
// ---------------------------------------------------------------------------

/** The ref-type prefix `/{src,commits}/` URLs carry (§3.3: required, as
 *  upstream's explicit `/branch|tag|commit/*` routes; the legacy no-prefix
 *  form is not claimed — it 404-shells instead). */
export type RefType = "branch" | "tag" | "commit";

/** Split the family suffix into its ref-type prefix and the ref+path rest.
 *  `null` = no (or a non-exact) prefix → 404 shell (§3.3). */
export function splitRefSuffix(suffix: string): { refType: RefType; rest: string } | null {
  for (const refType of ["branch", "tag", "commit"] as const) {
    if (suffix === refType) return { refType, rest: "" };
    if (suffix.startsWith(`${refType}/`)) return { refType, rest: suffix.slice(refType.length + 1) };
  }
  return null;
}

/** The ref name universe of one repository — `listRefs()` output plus the D1
 *  default branch (§4.9: unborn/broken HEAD falls back to that convention). */
export interface RefSuffixRefs {
  branches: readonly string[];
  tags: readonly string[];
  defaultBranch: string;
}

/** A resolved ref suffix: how the URL labeled it, the ref (branch/tag name,
 *  or the request's own sha prefix for `commit`), and the tree path under it. */
export interface ResolvedRefSuffix {
  refType: RefType;
  ref: string;
  treePath: string;
}

/** Upstream `getRefName` commit branch: `IsStringValidObjectID(fmt, part, 7)`
 *  — 7..64 hex, no existence check at parse time (upstream FIXME preserved;
 *  the engine readCommit resolves it in U3). */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/** The default branch to use when the URL carries no ref: the D1 default
 *  branch when it exists, else the first branch — upstream
 *  `RepoRefByType`'s `GetBranchNames(0, 1)` fallback (repo.go:964-971). */
function defaultBranchOf(refs: RefSuffixRefs): string | null {
  if (refs.branches.includes(refs.defaultBranch)) return refs.defaultBranch;
  return refs.branches[0] ?? null;
}

/**
 * Resolve a decoded ref+path suffix against a repository's refs. Semantics
 * (upstream `getRefNameFromPath`, repo.go:833-845):
 *
 * - The ref may bear slashes; the SHORTEST existing cumulative prefix wins
 *   (first match walking left to right) and the remainder is the tree path —
 *   so `feature/foo/README.md` with branch `feature/foo` is (ref
 *   `feature/foo`, tree `README.md`), and with branches `feature` AND
 *   `feature/foo` the shorter one wins, exactly upstream.
 * - An empty rest resolves to the default branch regardless of the declared
 *   prefix (upstream's `reqPath == ""` branch, repo.go:962-980).
 * - `branch` + literal `HEAD` → the default branch (repo.go:875-881). A
 *   branch actually named `HEAD` wins first via the walk.
 * - `commit` + literal `HEAD` → null here: upstream swaps in the default
 *   branch's commit id, which needs an engine round-trip — U3's page-data
 *   layer owns that resolution, and until then the caller 404-shells it.
 * - Anything unresolvable → null → 404 shell (§3.3, §4.5).
 */
export function resolveRefSuffix(refType: RefType, rest: string, refs: RefSuffixRefs): ResolvedRefSuffix | null {
  const parts = rest === "" ? [] : rest.split("/");

  if (parts.length === 0) {
    const fallback = defaultBranchOf(refs);
    return fallback === null ? null : { refType: "branch", ref: fallback, treePath: "" };
  }

  const walk = (names: readonly string[]): ResolvedRefSuffix | null => {
    const set = new Set(names);
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(0, i + 1).join("/");
      if (set.has(candidate)) {
        return { refType, ref: candidate, treePath: parts.slice(i + 1).join("/") };
      }
    }
    return null;
  };

  switch (refType) {
    case "branch": {
      const hit = walk(refs.branches);
      if (hit !== null) return hit;
      if (parts[0] === "HEAD") {
        const fallback = defaultBranchOf(refs);
        if (fallback !== null) return { refType: "branch", ref: fallback, treePath: parts.slice(1).join("/") };
      }
      return null;
    }
    case "tag":
      return walk(refs.tags);
    case "commit": {
      const sha = parts[0] as string;
      if (COMMIT_SHA.test(sha)) return { refType: "commit", ref: sha, treePath: parts.slice(1).join("/") };
      return null; // incl. HEAD — needs the engine (see doc comment)
    }
  }
}

// ---------------------------------------------------------------------------
// Assets seam (§2.3.4)
// ---------------------------------------------------------------------------

/** Structural type of the Workers static-assets fetcher binding, as read by
 *  `loadManifest`. Declared here (not taken from the generated Env) because
 *  the wrangler.jsonc `assets` block is the orchestrator's U1 wiring — until
 *  it lands, `Env` legitimately has no ASSETS member and the binding is
 *  absent at runtime, which is exactly the 503 path below. */
export interface UiAssetsFetcher {
  fetch(input: RequestInfo): Promise<Response>;
}

function isAssetsFetcher(value: unknown): value is UiAssetsFetcher {
  return typeof value === "object" && value !== null && "fetch" in value;
}

/** Read `env.ASSETS` without assuming the U1 wrangler wiring: the generated
 *  Env gains the member when the assets block lands (then `wrangler types`);
 *  until then this returns `undefined` → `AssetBuildError` → the 503. The
 *  `in` check narrows the unlisted member to `unknown` (TS 4.9+); the shape
 *  guard keeps a stray non-fetcher binding from reaching loadManifest. */
export function assetsBinding(env: Env): UiAssetsFetcher | undefined {
  if ("ASSETS" in env) {
    const binding: unknown = env.ASSETS;
    if (isAssetsFetcher(binding)) return binding;
  }
  return undefined;
}

/**
 * The §2.3.4 failure mode: a missing manifest, missing required entry, or
 * absent binding fails fast with 503 plain text instead of a broken page.
 * Git and API routes never pass through the shell (the assets config and the
 * dispatcher own those paths), so they are unaffected. Same plain-text shape
 * as the gate's error responses (`plainTextInternal`).
 */
export function assetsNotBuilt(error: AssetBuildError): Response {
  return new Response(`${error.message}\n`, {
    status: 503,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// uiRouter (§2.2 — the orchestrator mounts this at the dispatcher)
// ---------------------------------------------------------------------------

/** Narrow the parsed union back to the slice-1 route `renderUiPage` consumes
 *  (the two wave-2 dispatch branches above returned for every other member). */
function isSliceOneRoute(route: ParsedUiRoute): route is UiRoute {
  return route.family === "home" || route.family === "commits" || route.family === "src";
}

// ---------------------------------------------------------------------------
// Shared handler prologue + the wave-4 write handlers (§2.2)
// ---------------------------------------------------------------------------

/** The resolved parts every uiRouter handler shares (the §2.3.4 manifest
 *  load, the SPEC-0010 §2.5 viewer resolution and its Set-Cookie plumbing).
 *  `ok: false` carries the ready Response: the 503 assets failure or the
 *  null-parse 404 (registration/parser drift or a trailing slash — the
 *  middleware below 301s those). Repo-scoped handlers stack the §2.5 repo
 *  read on top (`ResolvedUiRequest`); the org home resolves an ORG instead
 *  (pages/org-home.tsx). */
type ResolvedUiSession =
  | {
      ok: true;
      url: URL;
      route: ParsedUiRoute;
      ctx: UiContext;
      viewer: Viewer;
      /** Attach the resolution's Set-Cookie directive (§2.4) when directed. */
      respond: (res: Response) => Response;
    }
  | { ok: false; response: Response };

async function resolveUiSession(c: Context<{ Bindings: Env }>): Promise<ResolvedUiSession> {
  const url = new URL(c.req.url);
  const route = parseUiRoute(url.pathname);
  // Only reachable through registration/parser drift or a trailing slash
  // (the middleware below turns the trailing-slash 404 into the canonical
  // 301) — never render the shell for a path the parser does not claim.
  if (route === null) return { ok: false, response: await c.notFound() };

  // SPEC-0010 §2.5 viewer resolution (the session wave's transition note in
  // viewer.ts): the session cookie is verified per request and every
  // response carries the rotation Set-Cookie when one is directed.
  // `c.executionCtx` is unavailable under direct `router.fetch` invocations
  // (the tests) — the resolver then settles its background work inline.
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  let ctx: UiContext;
  let setCookie: string | null = null;
  let viewer: Viewer;
  try {
    const manifest = await loadManifest(assetsBinding(c.env), url.origin);
    const resolution = await resolveViewer(c.env, c.req.raw, { waitUntil });
    // resolveViewer's setCookie is the RAW session value (id:secret) on
    // resolveViewer's setCookie is ALWAYS a full §2.7 directive now (the
    // rotation arm wraps there) — attach as-is. The old unconditional
    // re-wrap double-wrapped the clear arm's already-complete directive
    // (the dashboard matrix's RED).
    setCookie = resolution.setCookie;
    viewer = resolution.viewer;
    // The wave-10 navbar bell's unread count (head_navbar_icons.tmpl's
    // `.notification_count`): the derived-thread COUNT per signed-in request
    // — the same one-query cost upstream's PageGlobalData carries
    // (pages/notifications.tsx header). A failed read degrades to null (the
    // badge renders hidden — upstream NewAvailable's {new: 0} error arm).
    let notificationCount: number | null = null;
    if (viewer.kind === "user") {
      try {
        notificationCount = await countUnreadNotifications(c.env.DB, viewer.id);
      } catch {
        notificationCount = null;
      }
    }
    ctx = {
      viewer: resolution.viewer,
      origin: url.origin,
      notificationCount,
      assets: shellAssetsFromManifest(manifest),
    };
  } catch (error) {
    if (error instanceof AssetBuildError) return { ok: false, response: assetsNotBuilt(error) };
    throw error;
  }
  const respond = (res: Response): Response => {
    if (setCookie === null) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", setCookie);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  return { ok: true, url, route, ctx, viewer, respond };
}

type ResolvedUiRequest = Extract<ResolvedUiSession, { ok: true }> & { repo: RepoRow };

/**
 * The repo-scoped prologue: the shared session half, then the §2.5 repo
 * read — SPEC-0010 §2.6: the read widens through the gate's own grant lines
 * (shared readGrant predicate) — anonymous keeps the row-1 collapse
 * verbatim, a session viewer gains the authenticated read paths; anything
 * without a grant 404-shells exactly as before (existence stays hidden).
 */
async function resolveUiRequest(c: Context<{ Bindings: Env }>): Promise<ResolvedUiRequest | { ok: false; response: Response }> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved;
  // The owner-home family has no repo segment — only reachable through
  // registration drift (neither page handler calls this).
  const route = resolved.route;
  if (!("repo" in route)) return { ok: false, response: resolved.respond(await c.notFound()) };
  const repo = await resolveRepositoryForViewer(c.env, resolved.viewer, route.owner, route.repo);
  if (repo === null) return { ok: false, response: resolved.respond(c.html(renderNotFound(resolved.ctx), 404)) };
  resolved.ctx.repo = repo;
  // The Projects unit toggle (wave-45 — repo_settings.has_projects, the
  // landed store's MustEnableRepoProjects reduction): one PK read per
  // repo-scoped request. The shell's Projects tab (upstream repo/header.
  // tmpl:146-154 gates the tab on the SAME unit condition) and the
  // /projects group's handlers both read this flag.
  resolved.ctx.repoHasProjects = (await loadRepoSettings(c.env.DB, repo.id)).hasProjects;
  return { ...resolved, repo };
}

/**
 * The authed-page redirect (SPEC-0010 §2.5, the session wave's convention):
 * an anonymous viewer 303s onto the login form with this path as the
 * `redirect_to` round-trip target (the session router re-validates it
 * through `safeRedirectTarget` at use time). Repo resolution happens FIRST,
 * so an invisible repo 404-shells and never reveals itself through the
 * redirect.
 */
function loginRedirect(pathname: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/login?redirect_to=${encodeURIComponent(pathname)}` },
  });
}

/** GET /{owner}/{repo}/issues/new (pages/new-issue.tsx): the form for the
 *  signed-in viewer; anonymous 303s onto the login round-trip. Wave 26: the
 *  milestone-detail page's New Issue link preselects its milestone
 *  (`?milestone=` — upstream NewIssue's FormInt64("milestone"); a
 *  non-numeric or unknown id falls through to none, the form's own
 *  parsing). */
async function issueNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const data = await loadNewIssueData(c.env.DB, repo.id);
  const milestoneParam = (url.searchParams.get("milestone") ?? "").trim();
  const milestoneId =
    /^\d+$/.test(milestoneParam) && Number.parseInt(milestoneParam, 10) > 0
      ? Number.parseInt(milestoneParam, 10)
      : null;
  return respond(
    c.html(
      renderNewIssuePage({
        ctx,
        data,
        form: { title: "", content: "", labelIds: [], milestoneId },
        error: null,
      }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/issues/new (upstream NewIssuePost): the §2.8 layer-2
 * Origin guard, then the same repo→viewer order as the GET (invisible repos
 * 404 before the redirect could leak them), then the tier-1
 * `IssuesService.createIssue` — success 303s onto the created issue's detail
 * page (upstream `ctx.Redirect(issue.Link())`, 303 per base.go:157),
 * validation failures re-render the form at 200 with the message and the
 * submitted values (the login failure convention).
 */
async function issueNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const form = await readNewIssueForm(c.req.raw);
  // Archived repos refuse the write (the API create route's
  // assertNotArchived posture — the message cites it verbatim).
  if (repo.isArchived) {
    const data = await loadNewIssueData(c.env.DB, repo.id);
    return respond(c.html(renderNewIssuePage({ ctx, data, form, error: newIssueLocale.repo_archived }), 200));
  }
  // The emission hook rides the write (services/issue-events.ts): the SAME
  // issues "opened" fan-out the API POST route emits — the wave-4 divergence.
  const result = await createIssueFromForm(c.env.DB, repo.id, form, viewer.id, { request: c, origin: ctx.origin });
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLink}/issues/${result.issue.index}` } }));
  }
  const data = await loadNewIssueData(c.env.DB, repo.id);
  return respond(c.html(renderNewIssuePage({ ctx, data, form, error: result.message }), 200));
}

/** The settings admin gate (pages/settings.tsx header): anonymous → the
 *  login 303; a signed-in non-admin → the 404 shell (upstream settings
 *  pages are admin-only and equally undiscoverable). The grant rides the
 *  landed `isRepositoryAdmin` (repo-access.ts via ../repo-grants.ts — team
 *  grants included). Returns the Response to answer, or `null` to proceed. */
async function settingsGate(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
): Promise<Response | null> {
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (!(await canAdminRepo(c.env, repo, viewer))) return respond(c.html(renderNotFound(ctx), 404));
  return null;
}

/** GET /{owner}/{repo}/settings (pages/settings.tsx — the basics form). */
async function settingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const data = await loadRepoBasics(c.env.DB, resolved.repo);
  return resolved.respond(c.html(renderRepoSettingsPage({ ctx: resolved.ctx, data, error: null }), 200));
}

/** POST /{owner}/{repo}/settings — the basics write through the landed
 *  services (RepoService.rename/setVisibility + saveRepoSettings); success
 *  303s back onto the CANONICAL settings URL (a rename moves the slug). */
async function settingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const form = parseRepoBasicsForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyRepoBasics(c.env.DB, repo, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${result.slug}/settings` } }));
  }
  const data = await loadRepoBasics(c.env.DB, repo);
  data.form = { name: form.name, description: form.description, isPrivate: form.isPrivate };
  return respond(c.html(renderRepoSettingsPage({ ctx, data, error: result.message }), 200));
}

// ---------------------------------------------------------------------------
// Window-2d: the four settings-tab modules (githooks, protected tags,
// deploy keys, public access) — the shared settingsGate posture, drift
// guards per family, sameOriginGuard-first POSTs.
// ---------------------------------------------------------------------------

async function repoGitHooksPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { respond } = resolved;
  if (resolved.route.family !== "settings-githooks") return respond(await c.notFound()); // drift guard
  const data = await loadRepoGitHooks(c.env.REPO_PACKS, resolved.repo);
  return respond(c.html(renderRepoGitHooksListPage({ ctx: resolved.ctx, data }), 200));
}

async function repoGitHookEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-githook" || route.name === undefined) return respond(await c.notFound()); // drift guard
  // ErrNotValidHook → the 404 shell (the module handoff).
  const data = await loadRepoGitHookEdit(c.env.REPO_PACKS, resolved.repo, route.name);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderRepoGitHookEditPage({ ctx, data }), 200));
}

async function repoGitHookSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-githook" || route.name === undefined) return respond(await c.notFound()); // drift guard
  const form = parseRepoGitHookForm(await readUrlEncodedForm(c.req.raw));
  const data = await loadRepoGitHookEdit(c.env.REPO_PACKS, repo, route.name);
  if (data === null) return respond(c.html(renderNotFound(resolved.ctx), 404));
  await applyRepoGitHook(c.env.REPO_PACKS, repo, route.name, form);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/hooks/git` } }));
}

async function repoTagsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond, url } = resolved;
  if (resolved.route.family !== "settings-tags") return respond(await c.notFound()); // drift guard
  const editParam = url.searchParams.get("id");
  const editId = editParam !== null && /^\d+$/.test(editParam) ? Number.parseInt(editParam, 10) : null;
  const row = editId === null ? null : await loadTagRuleById(c.env.DB, repo.id, editId);
  const data = {
    rules: await loadProtectedTagRules(c.env.DB, repo),
    isOrg: await loadOwnerIsOrg(c.env.DB, repo),
    form: row !== null ? await editFormOfTag(c.env.DB, row) : emptyTagProtectionForm(),
    editing: row,
    saved: url.searchParams.get("saved") === "1",
  };
  return respond(c.html(renderTagProtectionPage({ ctx, data, error: null }), 200));
}

async function repoTagsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-tags" && route.family !== "settings-tag-detail") return respond(await c.notFound()); // drift guard
  if (route.family === "settings-tag-detail" && route.id === undefined) return respond(await c.notFound());
  // RepoMustNotBeArchived rides the POSTs (web.go:1216-1220).
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseTagProtectionForm(await readUrlEncodedForm(c.req.raw));
  // Upstream keys the EDIT by the URL path id (m.Post("/{id}") →
  // selectProtectedTagByContext), not a hidden field — the rendered form
  // carries none. Inject the route id (the module header's contract note;
  // the tags matrix's RED witness).
  if (route.family === "settings-tag-detail" && route.id !== undefined) form.id = route.id;
  const result = await applyTagProtectionForm(c.env.DB, pair, form);
  if (result.outcome === "created" || result.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/tags?saved=1` } }));
  }
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const data = {
    rules: await loadProtectedTagRules(c.env.DB, repo),
    isOrg: await loadOwnerIsOrg(c.env.DB, repo),
    form,
    editing: null,
    saved: false,
  };
  return respond(c.html(renderTagProtectionPage({ ctx, data, error: result.message }), 200));
}

async function repoTagDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-tag-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const row = await loadTagRuleById(c.env.DB, repo.id, route.id);
  if (row === null) return respond(c.html(renderNotFound(ctx), 404));
  const data = {
    rules: await loadProtectedTagRules(c.env.DB, repo),
    isOrg: await loadOwnerIsOrg(c.env.DB, repo),
    form: await editFormOfTag(c.env.DB, row),
    editing: row,
    saved: false,
  };
  return respond(c.html(renderTagProtectionPage({ ctx, data, error: null }), 200));
}

async function repoTagDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-tags-delete") return respond(await c.notFound()); // drift guard
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404));
  const params = await readUrlEncodedForm(c.req.raw);
  const rawId = params.get("id") ?? "";
  if (!/^\d+$/.test(rawId)) return respond(c.html(renderNotFound(ctx), 404));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const deleted = await deleteTagRuleById(c.env.DB, pair, Number.parseInt(rawId, 10));
  if (!deleted) return respond(c.html(renderNotFound(ctx), 404));
  // DeleteProtectedTagPost flashes update_settings_success — the ?saved=1
  // reduction (the module contract; the matrix's RED witness).
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/tags?saved=1` } }));
}

async function repoDeployKeysPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { respond } = resolved;
  if (resolved.route.family !== "settings-keys") return respond(await c.notFound()); // drift guard
  const data = await loadRepoDeployKeys(c.env.DB, resolved.repo);
  return respond(c.html(renderRepoDeployKeysPage({ ctx: resolved.ctx, data, error: null }), 200));
}

async function repoDeployKeysSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-keys") return respond(await c.notFound()); // drift guard
  const form = parseDeployKeyForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await addDeployKeyFromForm(c.env.DB, repo, form);
  const data = await loadRepoDeployKeys(c.env.DB, repo);
  if (outcome.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/keys` } }));
  }
  data.form = { title: form.title, content: form.content, isWritable: form.isWritable };
  return respond(c.html(renderRepoDeployKeysPage({ ctx, data, error: { message: outcome.message, field: outcome.field } })));
}

async function repoDeployKeysDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-keys-delete") return respond(await c.notFound()); // drift guard
  const form = parseDeployKeyDeleteForm(await readUrlEncodedForm(c.req.raw));
  // Idempotent (the module handoff: miss 204s API-side; the web twin 303s
  // on both outcomes).
  await deleteDeployKeyFromForm(c.env.DB, repo, form);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/keys` } }));
}

async function repoPublicAccessPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-public-access") return respond(await c.notFound()); // drift guard
  const data = await loadRepoPublicAccess(c.env.DB, repo.id);
  return respond(c.html(renderRepoPublicAccessPage({ ctx: resolved.ctx, data }), 200));
}

async function repoPublicAccessSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-public-access") return respond(await c.notFound()); // drift guard
  const form = parsePublicAccessForm(await readUrlEncodedForm(c.req.raw));
  await updateCodeUnitPublicAccess(c.env.DB, repo.id, form);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/public_access` } }));
}

async function repoWikiSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond, url } = resolved;
  if (resolved.route.family !== "settings-wiki") return respond(await c.notFound()); // drift guard
  const data = await loadRepoWikiSettings(c.env.DB, repo);
  return respond(c.html(renderRepoWikiSettingsPage({ ctx, data, error: null, saved: url.searchParams.get("saved") === "1" }), 200));
}

async function repoWikiSettingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-wiki") return respond(await c.notFound()); // drift guard
  const form = parseRepoWikiForm(await readUrlEncodedForm(c.req.raw));
  await applyRepoWikiSettings(c.env.DB, repo, form);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/wiki?saved=1` } }));
}

// ---------------------------------------------------------------------------
// Window-2e (pass 1): the aux/byte surfaces — sitemap XML + the two search
// JSON feeds (pages/sitemap.ts + pages/search-aux.ts).
// ---------------------------------------------------------------------------

async function sitemapRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, respond } = resolved;
  const route = resolved.route;
  // No session gate (optExploreSignIn could only inflate counts with
  // signed-in privates; the anonymous count is the safe public ceiling —
  // the module handoff).
  if (route.family === "home-sitemap") {
    return respond(sitemapXmlResponse(await loadHomeSitemapIndex(c.env.DB, url.origin)));
  }
  if (route.family === "explore-repos-sitemap") {
    if (route.idx === undefined) return respond(await c.notFound()); // drift guard
    return respond(sitemapXmlResponse(await loadReposSitemap(c.env.DB, url.origin, route.idx)));
  }
  if (route.family === "explore-users-sitemap") {
    if (route.idx === undefined) return respond(await c.notFound()); // drift guard
    return respond(sitemapXmlResponse(await loadUsersSitemap(c.env.DB, url.origin, route.idx)));
  }
  return respond(await c.notFound()); // drift guard
}

async function repoSearchAuxRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, viewer, respond } = resolved;
  if (resolved.route.family !== "repo-search-aux") return respond(await c.notFound()); // drift guard
  // reqSignIn (web.go:1097-1103). The API-layer Viewer needs the contract
  // User — built from the D1 row via the auth mapper (toApiUser, exported
  // for this bridge).
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return respond(c.html(renderNotFound(resolved.ctx), 404)); // the session doer vanished
  const apiViewer = {
    origin: url.origin,
    requester: toApiUser({
      id: userRow.id,
      username: userRow.username,
      usernameLower: userRow.usernameLower,
      email: userRow.email,
      displayName: userRow.displayName,
      isAdmin: userRow.isAdmin,
      status: userRow.status,
      createdAt: userRow.createdAt,
    }),
  };
  let params: ReturnType<typeof parseRepoSearchAuxQuery>;
  try {
    params = parseRepoSearchAuxQuery(url, true);
  } catch (error) {
    if (error instanceof SearchAuxParamError) {
      // Upstream ctx.HTTPError: the status + the plain message, HTML page —
      // never JSON.
      return respond(new Response(error.message, { status: 422, headers: { "content-type": "text/plain; charset=utf-8" } }));
    }
    throw error;
  }
  const result = await loadRepoSearchAux(c.env, apiViewer, params);
  return respond(
    params.countOnly
      ? repoSearchCountOnlyResponse(result.total)
      : repoSearchAuxResponse(result.total, { ok: true, data: result.data } satisfies WebSearchAuxResults),
  );
}

async function topicSearchAuxRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, respond } = resolved;
  if (resolved.route.family !== "explore-topic-search-aux") return respond(await c.notFound()); // drift guard
  // optSignIn — no gate.
  const params = parseTopicSearchAuxQuery(url);
  const result = await loadTopicSearchAux(c.env, params);
  return respond(topicSearchAuxResponse(result.total, { topics: result.topics }));
}

/** Window-2e: the .rss/.atom envelopes — resolve the owner through the
 *  activity-feeds seam (org-then-user, visibility-gated), then the byte
 *  render with the gorilla-parity content types. */
async function userFeedRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "user-feed-rss" && route.family !== "user-feed-atom") return respond(await c.notFound()); // drift guard
  const doer = orgFamilyDoer(viewer);
  const resolution = await resolveActivityFeeds(c.env.DB, route.owner, doer, url.pathname, url.search);
  if (resolution.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: resolution.location } }));
  }
  if (resolution.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const subject =
    resolution.kind === "org"
      ? {
          kind: "org" as const,
          id: resolution.org.id,
          username: resolution.org.username,
          fullName: resolution.org.fullName,
          email: resolution.org.email,
          description: resolution.org.description,
        }
      : {
          kind: "user" as const,
          id: resolution.user.id,
          username: resolution.user.username,
          fullName: resolution.user.fullName,
          email: resolution.user.email,
          description: resolution.user.description,
        };
  const data = await loadUserFeedData(c.env.DB, subject, viewer, url.origin, url.searchParams);
  const body = route.family === "user-feed-rss" ? renderUserFeedRss(data) : renderUserFeedAtom(data);
  return respond(
    new Response(body, {
      headers: { "content-type": route.family === "user-feed-rss" ? USER_FEED_CONTENT_TYPES.rss : USER_FEED_CONTENT_TYPES.atom },
    }),
  );
}

// ---------------------------------------------------------------------------
// Window-2e B2: the repo-scoped aux feeds + fragments. All ride
// resolveUiRequest (the repo read + visibility) with per-family drift
// guards; the notFound arms re-render the §4.5 shell (renderNotFound).
// ---------------------------------------------------------------------------

async function issuesSearchAuxRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, viewer, respond } = resolved;
  if (resolved.route.family !== "issues-search-aux") return respond(await c.notFound()); // drift guard
  if (viewer.kind !== "user") return respond(loginRedirect(url.pathname)); // reqSignIn (web.go:1440)
  const data = await loadIssuesSearchAux(
    c.env,
    { id: repo.id, isArchived: repo.isArchived },
    { id: viewer.id, username: viewer.username, isAdmin: viewer.isAdmin },
    url.origin,
    url,
  );
  return respond(issuesSearchResponse(data, renderNotFound(ctx)));
}

async function issuesSuggestionsAuxRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { respond } = resolved;
  if (resolved.route.family !== "issues-suggestions-aux") return respond(await c.notFound()); // drift guard
  // optSignIn + the viewer's unit reads — both readable while actions/
  // units are unlanded (the module's literal-true note); the raw q rides
  // UNTRIMMED (upstream FormValue).
  const suggestions = await loadIssuesSuggestionsAux(c.env, resolved.repo.id, suggestionsIsPullFilter(true, true), c.req.query("q") ?? "");
  return respond(issuesSuggestionsResponse(suggestions));
}

async function issueInfoFragmentRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, viewer, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-info" || route.index === undefined || route.urlKind === undefined) return respond(await c.notFound()); // drift guard
  const data = await loadIssueInfoFragment(c.env.DB, repo, route.urlKind, route.index, url.origin, viewer, repoLinkOf(repo));
  return respond(issueInfoFragmentResponse(data, renderNotFound(ctx)));
}

async function issueAttachmentsFragmentRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-attachments" || route.index === undefined) return respond(await c.notFound()); // drift guard
  const issue = await resolveFragmentIssue(c.env.DB, repo, route.index);
  if (issue === null) return respond(c.html(renderNotFound(ctx), 404));
  const rows = await loadIssueAttachmentsFragment(c.env.DB, issue.id);
  return respond(issueAttachmentsFragmentResponse(url.origin, rows));
}

async function issueContentOverviewRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-content-overview" || route.index === undefined) return respond(await c.notFound()); // drift guard
  const issue = await resolveFragmentIssue(c.env.DB, repo, route.index);
  if (issue === null) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadContentHistoryOverviewFragment(c.env.DB, issue);
  return respond(contentHistoryOverviewFragmentResponse(data));
}

async function issueAttachmentsAliasRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-attachments-alias" || route.segment === undefined) return respond(await c.notFound()); // drift guard
  // The byte arm IS the landed site-level seam — hand off (the module's
  // documented alias, no second handler).
  return respond(new Response(null, { status: 302, headers: { location: `/attachments/${route.segment}` } }));
}

async function pullMergeBoxRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, viewer, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "pull-merge-box" || route.index === undefined) return respond(await c.notFound()); // drift guard
  const found = await findPullRequestByIndex(c.env.DB, repo.id, route.index);
  if (found === null) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadPullMergeBoxData(c.env.DB, { repo, issue: found.issue, pr: found.pullRequest, viewer, origin: url.origin });
  // null → the EMPTY fragment (upstream's ShowMergeBox=false arm — the
  // bundle's reload stop signal).
  return respond(pullMergeBoxFragmentResponse(data === null ? "" : pullMergeBoxFragmentHtml(data)));
}

async function pullFilesRangeRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "pull-files-range" || route.index === undefined || route.segment === undefined) {
    return respond(await c.notFound()); // drift guard
  }
  const data = await loadPullFilesRange(c, repo.id, route.index, route.segment);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderPullFilesRangePage({ ctx, data })));
}

async function pullCommitFilesRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "pull-commit-files" || route.index === undefined || route.segment === undefined) {
    return respond(await c.notFound()); // drift guard
  }
  const data = await loadPullFilesSingleCommit(c, repo.id, route.index, route.segment);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderPullFilesSingleCommitPage({ ctx, data })));
}

async function activityAuthorDataRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "activity-author-data") return respond(await c.notFound()); // drift guard
  const data = await loadActivityAuthorData(
    c.env,
    { ownerNamespace: repo.ownerNamespace, slug: repo.slug, isEmpty: repo.isEmpty },
    route.segment ?? null,
    { origin: url.origin },
  );
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(activityAuthorDataResponse(data));
}

/** GET /{owner}/{repo}/settings/hooks (pages/settings.tsx — the webhooks
 *  list + add form). */
async function hooksSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const data = await loadHooksSettings(c.env.DB, resolved.repo.id);
  return resolved.respond(c.html(renderHooksSettingsPage({ ctx: resolved.ctx, data, error: null }), 200));
}

/** POST /{owner}/{repo}/settings/hooks — the add-hook write through the
 *  landed `createRepoHook`; success 303s back onto the list, the service's
 *  validation message re-renders the form with the submission kept. */
async function hooksSettingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const form = parseCreateHookForm(await readUrlEncodedForm(c.req.raw));
  const result = await createHookFromForm(c.env.DB, repo.id, form);
  if (result.outcome === "created") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/hooks` } }),
    );
  }
  const data = await loadHooksSettings(c.env.DB, repo.id);
  data.form = { name: form.name, payloadUrl: form.payloadUrl, contentType: form.contentType };
  return respond(c.html(renderHooksSettingsPage({ ctx, data, error: result.message }), 200));
}

/** GET /{owner}/{repo}/settings/mirror (pages/settings.tsx — the wave-10
 *  mirror panel; the settings gate + `?sync=queued` flash reduction). */
async function mirrorSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const syncQueued = resolved.url.searchParams.get("sync") === "queued";
  const data = await loadMirrorSettings(c.env.DB, resolved.repo.id, syncQueued);
  return resolved.respond(c.html(renderMirrorSettingsPage({ ctx: resolved.ctx, data, error: null }), 200));
}

/**
 * POST /{owner}/{repo}/settings/mirror — Synchronize Now (upstream
 * handleSettingsPostMirrorSync, setting.go:379-390): the mirror-sync enqueue
 * through syncMirrorNow; success 303s back with the `?sync=queued` flash
 * (upstream's Flash.Info + Redirect), the not-a-mirror/archived refusals
 * 404-shell exactly upstream's NotFound arm, the queue-side failures answer
 * the gate's 500 plain-text shape.
 */
async function mirrorSyncSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const result = await syncMirrorNow(c.env.DB, c.env.MIRROR_SYNC_QUEUE, repo);
  if (result.outcome === "queued") {
    return respond(
      new Response(null, {
        status: 303,
        headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/mirror?sync=queued` },
      }),
    );
  }
  if (result.outcome === "not-mirror" || result.outcome === "archived") {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const message = result.outcome === "no-queue" ? mirrorLocale.queue_missing : "mirror sync enqueue failed";
  return new Response(`${message}\n`, {
    status: 500,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// The wave-14 per-hook family (pages/settings.tsx — upstream WebHooksEdit /
// GiteaHooksEditPost / TestWebhook / DeleteWebhook)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/settings/hooks/{id} (pages/settings.tsx — the edit
 *  form + the recent-deliveries list; `?test=queued` renders the flash
 *  reduction's info message). The settings gate's order (repo → anonymous
 *  login 303 → signed-in non-admin 404 shell), the drift guard, then the
 *  repo-scoped hook read — an unknown or foreign-repo id 404-shells (the
 *  landed repoGetHook arm). */
async function hookDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-hook-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const data = await loadHookDetailData(c.env.DB, resolved.repo.id, route.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const testQueued = url.searchParams.get("test") === "queued";
  return respond(c.html(renderHookDetailPage({ ctx, data, error: null, testQueued }), 200));
}

/**
 * POST /{owner}/{repo}/settings/hooks/{id} — the edit write (upstream
 * GiteaHooksEditPost over the landed PATCH arm's service call): success 303s
 * back onto the page (upstream editWebhook's redirect), the 422
 * validations re-render at 200 with the message and the kept submission
 * (the login failure convention). The POST rides the page URL — upstream
 * type-prefixes it (`/gitea/{id}`); the module header's divergence note.
 */
async function hookDetailSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-hook-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const hook = await getRepoHook(c.env.DB, repo.id, route.id);
  if (hook === null) return respond(c.html(renderNotFound(ctx), 404));
  const hookLink = `${repoLinkOf(repo)}/settings/hooks/${hook.id}`;
  const form = parseHookEditForm(await readUrlEncodedForm(c.req.raw));
  const result = await editHookFromForm(c.env.DB, hook, form);
  if (result.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: hookLink } }));
  }
  const data = await loadHookDetailData(c.env.DB, repo.id, hook.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  data.form = form;
  return respond(c.html(renderHookDetailPage({ ctx, data, error: result.message, testQueued: false }), 200));
}

/** The resolved repo row's canonical link (the handlers' `RepoLink`). */
function repoLinkOf(repo: RepoRow): string {
  return `/${repo.ownerNamespace}/${repo.slug}`;
}

/**
 * POST /{owner}/{repo}/settings/hooks/{id}/test — the test-fire write
 * (upstream TestWebhook's literal tail over the landed repoTestHook arm's
 * steps): an empty repository fires nothing (the arm's early-204 answered
 * as a silent 303 back), then the representative push payload is built and
 * the delivery row inserted through fireHookTestDelivery — the Queue
 * enqueue rides c.executionCtx.waitUntil when the producer binding exists
 * (routes/hooks.ts's structural probe; VALUE-position access — never name
 * ExecutionContext in type position). Success 303s back with
 * `?test=queued` (the flash reduction).
 */
async function hookTestSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-hook-test" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const hook = await getRepoHook(c.env.DB, repo.id, route.id);
  if (hook === null) return respond(c.html(renderNotFound(ctx), 404));
  const hookLink = `${repoLinkOf(repo)}/settings/hooks/${hook.id}`;
  // The landed arm's empty-repo no-fire (TestHook's ctx.Repo.Commit == nil
  // early-204 — the services/hooks.ts header).
  if (repo.isEmpty) return respond(new Response(null, { status: 303, headers: { location: hookLink } }));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined; // in-process test callers have none (the pending D1 row is the truth)
  }
  await fireHookTestDelivery({
    d1: c.env.DB,
    hook,
    pair,
    user: userRow,
    origin: resolved.url.origin,
    queue: hookDeliveryQueueOf(c.env),
    waitUntil,
  });
  return respond(new Response(null, { status: 303, headers: { location: `${hookLink}?test=queued` } }));
}

/**
 * POST /{owner}/{repo}/settings/hooks/{id}/delete — upstream
 * DeleteWebhook's write (the landed deleteRepoHook arm): success 303s onto
 * the hooks list (upstream JSONRedirect's target); a miss 404-shells (the
 * landed DELETE arm's 404 — existence stays hidden).
 */
async function hookDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-hook-delete" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const deleted = await deleteRepoHook(c.env.DB, repo.id, route.id);
  if (!deleted) return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/hooks` } }));
}

/** GET on a POST-only family — upstream chi answers 405 for a registered
 *  path with the wrong method (the gate's plainTextInternal shape). */
function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed\n", {
    status: 405,
    headers: { "content-type": "text/plain;charset=utf-8", allow, "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// The wave-15 protected-branches family (pages/branch-protection.tsx —
// upstream's /settings/branches group, web.go:1206-1212, over the landed
// branch_protections API arms)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/settings/branches (pages/branch-protection.tsx — the
 *  rules list; the settings gate's order, the `?rule_name=` save-flash
 *  reduction display-only). */
async function branchProtectionListPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, repo, respond } = resolved;
  // The saved-rule flash rides the save POST's redirect target (upstream's
  // exact `?rule_name=` target, protected_branch.go:337); display-only.
  const savedRule = url.searchParams.get("rule_name");
  // An archived repo renders the warning instead of the list — the rows
  // need not load (branches.tmpl's IsArchived arm).
  const rules = repo.isArchived ? [] : await loadBranchProtectionRules(c.env.DB, repo.id);
  return respond(
    c.html(
      renderBranchProtectionListPage({
        ctx,
        data: { rules, isOrg: await loadOwnerIsOrg(c.env.DB, repo), savedRule: savedRule ?? null },
      }),
      200,
    ),
  );
}

/** GET /{owner}/{repo}/settings/branches/edit (pages/branch-protection.tsx —
 *  the create/edit form; `?rule_name=` keys the rule under edit, an unknown
 *  or foreign name falls back to the CREATE form exactly like upstream's
 *  SettingsProtectedBranch nil-rule arm). */
async function branchProtectionEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, repo, respond } = resolved;
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const isOrg = await loadOwnerIsOrg(c.env.DB, repo);
  // Archived repos render the warning instead of the form (the module
  // header — the POST could only 404).
  if (repo.isArchived) {
    return respond(
      c.html(renderBranchProtectionEditPage({ ctx, data: { form: emptyBranchProtectionForm(), isOrg, rule: null }, error: null }), 200),
    );
  }
  const ruleName = url.searchParams.get("rule_name") ?? "";
  const rule = ruleName === "" ? null : (await loadBranchProtectionRules(c.env.DB, repo.id)).find((item) => item.row.ruleName === ruleName) ?? null;
  const form = rule === null ? emptyBranchProtectionForm() : await editFormOfRule(c.env.DB, pair, rule);
  return respond(c.html(renderBranchProtectionEditPage({ ctx, data: { form, isOrg, rule }, error: null }), 200));
}

/**
 * POST /{owner}/{repo}/settings/branches/edit — the create-or-edit write
 * (upstream SettingsProtectedBranchPost over the landed create/PATCH arms;
 * pages/branch-protection.tsx's header carries the arm-by-arm citations):
 * the hidden rule_id splits the arms, the 403/422 messages re-render the
 * form with the kept submission (the login failure convention), success
 * 303s onto `/settings/branches?rule_name=<saved>` — upstream's exact
 * redirect target. An edit id that is missing or foreign 404-shells
 * (existence hidden, the hook-detail posture).
 */
async function branchProtectionEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // RepoMustNotBeArchived
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const isOrg = await loadOwnerIsOrg(c.env.DB, repo);
  const form = parseBranchProtectionForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyBranchProtectionForm(c.env.DB, pair, form);
  if (result.outcome === "created" || result.outcome === "saved") {
    return respond(
      new Response(null, {
        status: 303,
        headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/branches?rule_name=${encodeURIComponent(result.ruleName)}` },
      }),
    );
  }
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  // The invalid re-render keeps the submission (the login failure
  // convention); the rule binding stays whatever the form's rule_id says —
  // a validation re-render of an EDIT keeps the edit header only when the
  // row actually resolved, which the apply call just proved it did not need.
  const ruleId = form.ruleId;
  const rule =
    ruleId === 0
      ? null
      : ((await loadBranchProtectionRules(c.env.DB, repo.id)).find((item) => item.row.id === ruleId) ?? null);
  const data: BranchProtectionEditData = { form, isOrg, rule };
  return respond(c.html(renderBranchProtectionEditPage({ ctx, data, error: result.message }), 200));
}

/**
 * POST /{owner}/{repo}/settings/branches/{id}/delete — the delete write
 * (upstream DeleteProtectedBranchRulePost's literal route over the landed
 * DELETE arm): success 303s onto the list (upstream's JSONRedirect target),
 * a missing/foreign id 404-shells (the arm's 404 — existence stays hidden).
 */
async function branchProtectionDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-branch-delete" || route.id === undefined) return respond(await c.notFound()); // drift guard
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // RepoMustNotBeArchived posture
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const deleted = await deleteRuleById(c.env.DB, pair, route.id);
  if (!deleted) return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/branches` } }));
}

/**
 * POST /{owner}/{repo}/settings/branches/priority — the reorder write
 * (upstream UpdateBranchProtectionPriories' literal route over the landed
 * priority op): the repeated `ids` fields carry the full reordered id list
 * (the no-JS form's `{ids}` shape — pages/branch-protection.tsx's header);
 * success 303s back onto the list (upstream's JS reloads the page).
 */
async function branchProtectionPrioritySubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (repo.isArchived) return respond(c.html(renderNotFound(resolved.ctx), 404)); // RepoMustNotBeArchived (wraps upstream's route)
  await reorderRules(c.env.DB, repo.id, parsePriorityIds(await readUrlEncodedForm(c.req.raw)));
  return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/branches` } }));
}

// ---------------------------------------------------------------------------
// The wave-16 branches family (pages/branches.tsx — upstream's
// `m.Get("/branches", repo.Branches)` list + `m.Post("/branches/delete",
// repo.DeleteBranchPost)` write, web.go:1478-1482's group)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/branches (pages/branches.tsx — the list): every
 *  viewer who can see the repo reads it (anonymous-capable — the page's
 *  controls gate themselves on the loaded grants); `?q=` filters, `?page=`
 *  paginates, and the deletion-flash params are display-only. */
async function branchesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "branches") return respond(await c.notFound()); // registration/parser drift guard
  const page = parsePageNumber(url.searchParams.get("page"));
  const keyword = (url.searchParams.get("q") ?? "").slice(0, 255);
  const data = await loadBranchesData(c.env, c.env.DB, repo, { page, keyword, viewer });
  // The Switch Default Branch link rides the settings page's own gate
  // (pages/branches.tsx's divergence note — upstream gates on IsWriter).
  const canAdmin = await canAdminRepo(c.env, repo, viewer);
  return respond(
    c.html(
      renderBranchesPage({
        ctx,
        data,
        canAdmin,
        flash: {
          deleted: url.searchParams.get("deleted"),
          errorKind: url.searchParams.get("delete_error"),
          errorName: url.searchParams.get("name") ?? "",
        },
      }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/branches/delete — the delete write (upstream
 * DeleteBranchPost's literal route over the landed API DELETE arm's steps
 * plus the M2 deletion predicate — pages/branches.tsx's module header
 * carries the why): the §2.8 Origin guard, the repo→viewer order, the
 * archived/empty 404 shells (RepoMustNotBeArchived + MustBeNotEmpty's UI
 * posture), then applyBranchDelete. Every refusal 303s back onto the list
 * with its flash param (upstream's JSONError texts), a deleted branch too
 * (the success flash); a missing branch name 404-shells (the API arm's
 * declared 404 — existence stays hidden).
 */
async function branchDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "branch-delete") return respond(await c.notFound()); // registration/parser drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (repo.isArchived || repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  const name = parseBranchDeleteForm(await readUrlEncodedForm(c.req.raw));
  if (name === "") return respond(c.html(renderNotFound(ctx), 404));
  const doerRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doerRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined; // in-process test callers have no execution context
  }
  const result = await applyBranchDelete(c.env, repo, viewer, name, { pair, doer: doerRow, origin: url.origin, waitUntil });
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const listPath = `/${repo.ownerNamespace}/${repo.slug}/branches`;
  const location =
    result.outcome === "deleted"
      ? `${listPath}?deleted=${encodeURIComponent(result.name)}`
      : `${listPath}?delete_error=${result.outcome === "refused-default" ? "default" : result.outcome === "refused-protected" ? "protected" : "failed"}&name=${encodeURIComponent(result.name)}`;
  return respond(new Response(null, { status: 303, headers: { location } }));
}

/**
 * GET /{owner} — the owner home (upstream `OwnerProfile`,
 * routers/web/user/profile.go:37): the session prologue WITHOUT the repo
 * read; the name resolves as an ORG first (pages/org-home.tsx — the
 * orgAssignment + RedirectToUser seam, then HasOrgOrUserVisible), then as a
 * USER (pages/user-profile.tsx — the type-gated user lookup, the shared
 * RedirectToUser redirect seam, then IsUserVisibleToViewer). A renamed name
 * 307s onto the new name (the shared user_redirects seam, query preserved),
 * an invisible or unknown name 404-shells — indistinguishable from missing,
 * existence never leaks.
 */
async function ownerHomePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, route, ctx, viewer, respond } = resolved;
  if (route.family !== "owner-home") return respond(await c.notFound()); // registration/parser drift guard
  const doer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const pathname = url.pathname;
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  // The ORG half first (upstream ContextUser.IsOrganization's true arm): an
  // org renders the org home; its redirect arm is the shared seam.
  const org = await resolveOrgHome(c.env.DB, route.owner, doer, pathname, query);
  if (org.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: org.location } }));
  }
  if (org.kind === "org") {
    const data = await loadOrgHomeData(c.env.DB, org.org, doer, url.searchParams);
    return respond(c.html(renderOrgHomePage(ctx, data), 200));
  }
  // The USER half (the false arm): a plain user renders the profile, a
  // renamed user 307s through the same seam, anything else 404-shells.
  const profile = await resolveUserProfile(c.env.DB, route.owner, doer, pathname, query);
  if (profile.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: profile.location } }));
  }
  if (profile.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadUserProfileData(c.env.DB, profile.user, doer, url.searchParams);
  return respond(c.html(renderUserProfilePage(ctx, data), 200));
}

/** GET /{owner}/{repo}/milestones (pages/milestones.tsx — the list; every
 *  viewer who can see the repo; the write predicates ride along for the New
 *  button's admin gate and the wave-26 per-row Edit link's writer gate). */
async function milestonesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  const data = await loadMilestonesData(c.env.DB, repo.id, url.searchParams);
  data.canWrite = await canAdminRepo(c.env, repo, viewer);
  data.canWriteIssues = await canWriteRepo(c.env, repo, viewer);
  return respond(c.html(renderMilestonesPage(ctx, data), 200));
}

/** GET /{owner}/{repo}/milestones/new (pages/milestones.tsx — the form).
 *  The settings gate's order: anonymous → the login 303 (repo resolution
 *  FIRST, so an invisible repo 404-shells before the redirect could leak
 *  it), a signed-in non-admin → the 404 shell. */
async function milestoneNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  return resolved.respond(
    c.html(renderNewMilestonePage({ ctx: resolved.ctx, form: { title: "", content: "", deadline: "" }, error: null }), 200),
  );
}

/**
 * POST /{owner}/{repo}/milestones/new (upstream NewMilestonePost,
 * routers/web/repo/milestone.go:107-136): the §2.8 Origin guard, the same
 * repo→gate order as the GET, then the landed `createRepoMilestone` —
 * success 303s back onto the list (`ctx.Redirect(RepoLink + "/milestones")`,
 * 303 per base.go:157); validation failures re-render the form at 200 with
 * the message and the submitted values (the login failure convention).
 * Archived repos refuse the write (upstream `context.RepoMustNotBeArchived()`
 * wraps the milestones group) with the API's exact message re-rendered.
 */
async function milestoneNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const form = parseMilestoneForm(await readUrlEncodedForm(c.req.raw));
  if (repo.isArchived) {
    return respond(c.html(renderNewMilestonePage({ ctx, form, error: milestonesLocale.repo_archived }), 200));
  }
  const result = await createMilestoneFromForm(c.env.DB, repo.id, form);
  if (result.outcome === "created") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/milestones` } }),
    );
  }
  return respond(c.html(renderNewMilestonePage({ ctx, form, error: result.message }), 200));
}

// ---------------------------------------------------------------------------
// The wave-12 user settings page (pages/user-settings.tsx — upstream's
// reqSignIn /user/settings)
// ---------------------------------------------------------------------------

/**
 * GET /user/settings (pages/user-settings.tsx — the profile form): the
 * session prologue WITHOUT the repo read, then the signed-in gate — an
 * anonymous viewer 303s onto the login round-trip (upstream reqSignIn), a
 * signed-in viewer manages exactly their own row. A session doer without a
 * D1 row 404-shells (the silent-auth-failure convention).
 */
async function userSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const data = await loadUserSettingsPageData(c.env.DB, viewer.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderUserSettingsPage(ctx, data), 200));
}

/**
 * POST /user/settings — the profile write: the §2.8 Origin guard, the same
 * session→gate order as the GET, then the PATCH route's exact service
 * sequence (saveUserProfileColumns + saveUserSettings, pages/user-settings.tsx
 * module header). Always succeeds — the landed services carry no validation
 * arms — so success 303s back onto the canonical URL (upstream
 * SettingsPost's redirect; the flash reduction).
 */
async function userSettingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const row = await loadUserSettingsPageData(c.env.DB, viewer.id);
  if (row === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseUserProfileForm(await readUrlEncodedForm(c.req.raw));
  await applyUserProfileForm(c.env.DB, viewer.id, form);
  return respond(new Response(null, { status: 303, headers: { location: "/user/settings" } }));
}

// ---------------------------------------------------------------------------
// Window-2a: the user-settings tab pages (the two-stage module wave, each
// module's header recipe). Every handler follows the wave-12 prologue
// (session → signed-in gate → doer-without-row 404 shell); POSTs take
// sameOriginGuard FIRST (§2.8); invalid outcomes re-render with the
// module's structured error; success 303s onto the canonical URL unless
// the module's recipe says otherwise (applications' one-shot plaintext
// banner re-renders instead).
// ---------------------------------------------------------------------------

/** The shared tab-page session prologue: guard → session → gates, answering
 *  {viewer, respond} or a terminal Response. */
async function userSettingsTabPrologue(c: Context<{ Bindings: Env }>, withOriginGuard: boolean): Promise<
  { ok: true; url: URL; ctx: UiContext; viewer: Extract<Viewer, { kind: "user" }>; respond: (r: Response, status?: number) => Response } | { ok: false; response: Response }
> {
  if (withOriginGuard) {
    const guard = sameOriginGuard(c.req.raw);
    if (guard !== null) return { ok: false, response: guard };
  }
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return { ok: false, response: resolved.response };
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return { ok: false, response: respond(loginRedirect(url.pathname)) };
  return { ok: true, url, ctx, viewer, respond };
}

async function userSettingsAppearancePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsAppearancePageData(c.env.DB, p.viewer.id);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserSettingsAppearancePage(p.ctx, data), 200));
}

async function userSettingsAppearanceSubmit(
  c: Context<{ Bindings: Env }>,
  arm: "theme" | "language",
): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const params = await readUrlEncodedForm(c.req.raw);
  let outcome: { outcome: "saved" } | { outcome: "invalid"; message: string };
  if (arm === "theme") {
    outcome = await applyUserSettingsAppearanceThemeForm(c.env.DB, p.viewer.id, parseUserSettingsAppearanceThemeForm(params));
  } else {
    outcome = await applyUserSettingsAppearanceLanguageForm(c.env.DB, p.viewer.id, parseUserSettingsAppearanceLanguageForm(params));
  }
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/appearance" } }));
  }
  const data = await loadUserSettingsAppearancePageData(c.env.DB, p.viewer.id);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserSettingsAppearancePage(p.ctx, data, { form: arm, message: outcome.message })));
}

async function userSettingsSecurityPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsSecurityPageData(c.env.DB, p.viewer.id);
  return p.respond(c.html(renderUserSettingsSecurityPage(p.ctx, data), 200));
}

async function userSettingsSecretsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsSecretsPageData(c.env.DB, p.viewer.id);
  return p.respond(c.html(renderUserSettingsSecretsPage(p.ctx, data), 200));
}

async function userSettingsSecretsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsSecretForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyUserSettingsSecretForm(c.env.DB, p.viewer.id, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/secrets" } }));
  }
  const data = await loadUserSettingsSecretsPageData(c.env.DB, p.viewer.id);
  // Carried name/description only — the value textarea stays empty
  // (plaintext never enters the DOM; the module's hard rule).
  data.form = { name: form.name, data: "", description: form.description };
  return p.respond(c.html(renderUserSettingsSecretsPage(p.ctx, data, outcome.message)));
}

async function userSettingsSecretsDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsSecretDeleteForm(await readUrlEncodedForm(c.req.raw));
  await deleteUserSettingsSecret(c.env.DB, p.viewer.id, form);
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/secrets" } }));
}

async function userSettingsVariablesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsVariablesPageData(c.env.DB, p.viewer.id);
  return p.respond(c.html(renderUserSettingsVariablesPage(p.ctx, data), 200));
}

async function userSettingsVariablesNew(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyUserSettingsVariableCreate(c.env.DB, p.viewer.id, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/variables" } }));
  }
  const data = await loadUserSettingsVariablesPageData(c.env.DB, p.viewer.id);
  if (outcome.outcome === "invalid") {
    // The handoff's carried add values (variables render plaintext —
    // faithful to carry the triple).
    data.form = { name: form.name, data: form.data, description: form.description };
    return p.respond(c.html(renderUserSettingsVariablesPage(p.ctx, data, outcome.message)));
  }
  return p.respond(c.html(renderNotFound(p.ctx), 404));
}

async function userSettingsVariablesEdit(c: Context<{ Bindings: Env }>, id: number): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyUserSettingsVariableUpdate(c.env.DB, p.viewer.id, id, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/variables" } }));
  }
  if (outcome.outcome === "missing") {
    // Upstream's findActionsVariable misses are ctx.NotFound(nil) — a
    // genuine 404, not a flash (the module handoff's fidelity call).
    return p.respond(c.html(renderNotFound(p.ctx), 404));
  }
  const data = await loadUserSettingsVariablesPageData(c.env.DB, p.viewer.id);
  data.form = { name: form.name, data: form.data, description: form.description };
  return p.respond(c.html(renderUserSettingsVariablesPage(p.ctx, data, outcome.message)));
}

async function userSettingsVariablesDelete(c: Context<{ Bindings: Env }>, id: number): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const outcome = await deleteUserSettingsVariable(c.env.DB, p.viewer.id, id);
  if (outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/variables" } }));
}

async function userSettingsHooksPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsHooksPageData(c.env.DB, p.viewer.id);
  return p.respond(c.html(renderUserSettingsHooksPage({ ctx: p.ctx, data, error: null })));
}

async function userSettingsHooksCreate(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseCreateHookForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await createUserHookFromForm(c.env.DB, p.viewer.id, form);
  if (outcome.outcome === "created") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/hooks" } }));
  }
  const data = await loadUserSettingsHooksPageData(c.env.DB, p.viewer.id);
  // The org twin's carried form (orgHooksSettingsSubmit precedent).
  data.form = { name: form.name, payloadUrl: form.payloadUrl, contentType: form.contentType };
  return p.respond(c.html(renderUserSettingsHooksPage({ ctx: p.ctx, data, error: outcome.message })));
}

async function userHookDetailPage(c: Context<{ Bindings: Env }>, hookId: number): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserHookDetailData(c.env.DB, p.viewer.id, hookId);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserHookDetailPage({ ctx: p.ctx, data, error: null })));
}

async function userHookDetailSubmit(c: Context<{ Bindings: Env }>, hookId: number): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const data = await loadUserHookDetailData(c.env.DB, p.viewer.id, hookId);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  const form = parseHookEditForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await editUserHookFromForm(c.env.DB, data.hook, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: `/user/settings/hooks/${hookId}` } }));
  }
  return p.respond(c.html(renderUserHookDetailPage({ ctx: p.ctx, data, error: outcome.message })));
}

async function userHookDelete(c: Context<{ Bindings: Env }>, hookId: number): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const deleted = await deleteUserHook(c.env.DB, p.viewer.id, hookId);
  if (!deleted) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/hooks" } }));
}

async function userSettingsKeysPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const owner = await loadUserSettingsKeysOwner(c.env.DB, p.viewer.id);
  if (owner === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  const data = await loadUserSettingsKeysPageData(c.env.DB, p.viewer.id);
  return p.respond(c.html(renderUserSettingsKeysPage(p.ctx, data)));
}

async function userSettingsKeysSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const owner = await loadUserSettingsKeysOwner(c.env.DB, p.viewer.id);
  if (owner === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  const form = parseUserSettingsKeysForm(await readUrlEncodedForm(c.req.raw));
  const outcome = form.type === "gpg"
    ? await addGpgKeyFromForm(c.env.DB, owner, form)
    : await addSshKeyFromForm(c.env.DB, owner, form);
  const data = await loadUserSettingsKeysPageData(c.env.DB, p.viewer.id);
  if (outcome.outcome === "created") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/keys" } }));
  }
  // The handoff's carried form values (upstream's browser keeps them; the
  // no-JS reduction re-renders them server-side).
  data.form = {
    title: form.title,
    content: form.type === "ssh" ? form.content : "",
    gpgContent: form.type === "gpg" ? form.content : "",
  };
  return p.respond(c.html(renderUserSettingsKeysPage(p.ctx, data, { kind: outcome.kind, message: outcome.message, field: outcome.field })));
}

async function userSettingsKeysDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsKeysDeleteForm(await readUrlEncodedForm(c.req.raw));
  if (form.type === "gpg") {
    // Idempotent by the module's port (subkeys die with the primary; a
    // miss is the stale-form arm).
    await deleteGpgKey(c.env.DB, p.viewer.id, form.id ?? 0);
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/keys" } }));
  }
  const outcome = await deleteSshKey(c.env.DB, p.viewer.id, form.id ?? 0);
  if (outcome === "missing") {
    // keys.go:301-303: JSONError("Failed to delete SSH key") with NO
    // redirect — the no-JS reduction re-renders the page with the line.
    const data = await loadUserSettingsKeysPageData(c.env.DB, p.viewer.id);
    return p.respond(c.html(renderUserSettingsKeysPage(p.ctx, data, { kind: "ssh", message: "Failed to delete SSH key" })));
  }
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/keys" } }));
}

async function userSettingsApplicationsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsApplicationsPageData(c.env.DB, p.viewer.id, p.viewer.isAdmin);
  return p.respond(c.html(renderUserSettingsApplicationsPage(p.ctx, data)));
}

async function userSettingsApplicationsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsApplicationsForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await createTokenFromForm(c.env.DB, p.viewer.id, form);
  const data = await loadUserSettingsApplicationsPageData(c.env.DB, p.viewer.id, p.viewer.isAdmin);
  if (outcome.outcome === "created") {
    // The one-shot plaintext banner: a full-page re-render carrying the
    // value exactly once (the no-fetch-action analog; no 303 — upstream's
    // flash would drop the token).
    data.newToken = outcome.plaintext;
    return p.respond(c.html(renderUserSettingsApplicationsPage(p.ctx, data)));
  }
  // The handoff's carried name (upstream's browser keeps it).
  data.form = { name: form.name };
  return p.respond(c.html(renderUserSettingsApplicationsPage(p.ctx, data, outcome.message)));
}

async function userSettingsApplicationsDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsApplicationsDeleteForm(await readUrlEncodedForm(c.req.raw));
  await revokeTokenFromForm(c.env.DB, p.viewer.id, form.id ?? 0);
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/applications" } }));
}

async function userSettingsOrganizationsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserOrgsSettings(c.env.DB, p.viewer.id, p.url.searchParams);
  const error = p.url.searchParams.get("error") === "last-owner" ? "last-owner" : null;
  return p.respond(c.html(renderUserOrgsSettingsPage(p.ctx, data, { error })));
}

async function userSettingsOrganizationsLeave(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserOrgsLeaveForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyUserOrgsLeave(c.env.DB, p.viewer.id, form);
  const location =
    outcome.outcome === "left"
      ? "/"
      : outcome.outcome === "last-owner"
        ? "/user/settings/organization?error=last-owner"
        : "/user/settings/organization";
  return p.respond(new Response(null, { status: 303, headers: { location } }));
}

// ---------------------------------------------------------------------------
// The wave-19 creation pages (pages/repo-create.tsx + pages/org-create.tsx —
// upstream's reqSignIn /repo/create + /org/create groups, the parity
// survey's #2 authoring front door)
// ---------------------------------------------------------------------------

/**
 * GET /repo/create (pages/repo-create.tsx — upstream repo.Create,
 * routers/web/repo/repo.go:142): the session prologue WITHOUT the repo read,
 * then the signed-in gate — an anonymous viewer 303s onto the login
 * round-trip (upstream reqSignIn). A session doer without a D1 row
 * 404-shells (the silent-auth-failure convention). `?org={id}` (upstream's
 * checkContextUser arm — the dashboard widget's deep link) preselects an
 * ALLOWED owner, anything else falls back to the doer.
 */
async function repoCreatePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const data = await loadRepoCreateData(c.env.DB, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const orgParam = url.searchParams.get("org") ?? "";
  const uid =
    /^\d+$/.test(orgParam) && data.owners.some((owner) => owner.id === Number.parseInt(orgParam, 10))
      ? Number.parseInt(orgParam, 10)
      : null;
  return respond(
    c.html(
      renderRepoCreatePage({
        ctx,
        data,
        // The private checkbox defaults CHECKED (the DefaultPushCreatePrivate
        // directive — pages/repo-create.tsx header); uid null = the doer.
        form: { uid, name: "", description: "", isPrivate: true, autoInit: false },
        error: null,
      }),
      200,
    ),
  );
}

/**
 * POST /repo/create (upstream repo.CreatePost, repo.go:202): the §2.8 Origin
 * guard, the same session→gate order as the GET, then the landed create arms
 * dispatched on the owner select (pages/repo-create.tsx's createRepoFromForm
 * — createUserRepository for the doer, requireCanCreateOrgRepo +
 * RepoService.create for an org, the `repository` created webhook riding
 * both). Success 303s onto the new repo's home (upstream
 * `ctx.Redirect(repo.Link())`, 303 per base.go:157); failures re-render the
 * form at 200 with the message and the submitted values (the login failure
 * convention).
 */
async function repoCreateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const data = await loadRepoCreateData(c.env.DB, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseRepoCreateForm(await readUrlEncodedForm(c.req.raw));
  const result = await createRepoFromForm(c.env, c.env.DB, viewer, data, form, { request: c, origin: ctx.origin });
  if (result.outcome === "created") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${result.ownerNamespace}/${result.slug}` } }),
    );
  }
  return respond(c.html(renderRepoCreatePage({ ctx, data, form, error: result.message }), 200));
}

/**
 * GET /org/create (pages/org-create.tsx — upstream org.Create,
 * routers/web/org/org.go:30): the same session→gate order; the
 * CanCreateOrganization site-config gate is unreachable at the landed tier
 * (the module header), so every signed-in viewer renders the form.
 */
async function orgCreatePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  return respond(
    c.html(
      renderOrgCreatePage({
        ctx,
        // The GET defaults: visibility public (upstream's
        // DefaultOrgVisibilityMode default), the permission box CHECKED
        // (upstream GET's repo_admin_change_team_access = true).
        form: { name: "", fullName: "", email: "", visibility: "public", repoAdminChangeTeamAccess: true },
        error: null,
      }),
      200,
    ),
  );
}

/**
 * POST /org/create (upstream org.CreatePost, org.go:44): the §2.8 Origin
 * guard, the same session→gate order, then the landed `POST /orgs` service
 * (`OrgService.createOrg` — the creator's owner membership rides the same
 * batch). Success 303s onto the ORG HOME `/{org}` (upstream redirects onto
 * DashboardLink — a surface this UI does not carry, the module header's
 * divergence); the typed OrgError family re-renders inline with the kept
 * submission (the login failure convention).
 */
async function orgCreateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // sessions are user-shaped
  const form = parseOrgCreateForm(await readUrlEncodedForm(c.req.raw));
  const result = await createOrgFromForm(c.env.DB, viewer, form);
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `/${result.org.username}` } }));
  }
  return respond(c.html(renderOrgCreatePage({ ctx, form, error: result.message }), 200));
}

// ---------------------------------------------------------------------------
// The wave-12 org teams family (pages/org-teams.tsx — upstream's
// /{org}/teams group, web.go:993-1013)
// ---------------------------------------------------------------------------

/** The org-teams prologue the four handlers share (the settings gate's shape
 *  over the org resolution): the session half, the owner-segment drift
 *  guard, the org resolution (a renamed org 307s onto the new name, an
 *  unknown name 404-shells), the anonymous login 303, then the landed
 *  `requireOrgOwnership` posture — a signed-in non-owner 404-shells (the
 *  pages/org-teams.tsx header; upstream answers NotFound for every
 *  non-member). */
type ResolvedOrgTeamsRequest = Extract<ResolvedUiSession, { ok: true }> & { org: OrgRecord };

async function resolveOrgTeamsRequest(c: Context<{ Bindings: Env }>): Promise<ResolvedOrgTeamsRequest | { ok: false; response: Response }> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved;
  const { url, ctx, viewer, respond } = resolved;
  const route = resolved.route;
  if (!("owner" in route)) return { ok: false, response: respond(await c.notFound()) }; // registration/parser drift guard
  const doer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const org = await resolveOrgTeamsOrg(c.env.DB, route.owner, doer, url.pathname, query);
  if (org.kind === "redirect") {
    return { ok: false, response: respond(new Response(null, { status: 307, headers: { location: org.location } })) };
  }
  if (org.kind === "missing") return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  if (viewer.kind === "anonymous") return { ok: false, response: respond(loginRedirect(url.pathname)) };
  if (!(await canManageOrgTeams(c.env.DB, org.org, viewer))) {
    return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  }
  return { ...resolved, org: org.org };
}

/** GET /{org}/teams (pages/org-teams.tsx — the teams list; the landed
 *  orgListTeams read's owner arm). */
async function orgTeamsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, respond } = resolved;
  if (resolved.route.family !== "org-teams") return respond(await c.notFound()); // drift guard
  const data = await loadOrgTeamsData(c.env.DB, resolved.org, url.searchParams);
  return respond(c.html(renderOrgTeamsPage(ctx, data), 200));
}

/** GET /{org}/teams/{id} (pages/org-teams.tsx — the detail slice: the
 *  members list + the repo-access list; an unknown or foreign-org id
 *  404-shells). */
async function orgTeamDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-team-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const data = await loadOrgTeamDetailData(c.env.DB, resolved.org, route.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderOrgTeamDetailPage(ctx, data), 200));
}

/** GET /{org}/teams/new (pages/org-teams.tsx — the create form; the same
 *  gate as the list). */
async function orgTeamNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-team-new") return respond(await c.notFound()); // drift guard
  return respond(c.html(renderOrgTeamNewPage(ctx, { org: resolved.org, form: { name: "", permission: "read" }, error: null }), 200));
}

/**
 * POST /{org}/teams/new (upstream NewTeamPost, routers/web/org/teams.go:
 * 344-390 over the landed create arm): the §2.8 Origin guard, the shared
 * prologue, then `TeamsService.createTeam` — success 303s onto the created
 * team's detail slice (upstream redirects onto the team's page; the slice
 * keys on the id — the module header's route-shape note); the typed NewTeam
 * 422s re-render the form at 200 with the message and the submitted values
 * (the login failure convention).
 */
async function orgTeamNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-team-new") return respond(await c.notFound()); // drift guard
  const form = parseTeamNewForm(await readUrlEncodedForm(c.req.raw));
  const result = await createTeamFromForm(c.env.DB, org, form);
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/teams/${result.team.id}` } }));
  }
  return respond(c.html(renderOrgTeamNewPage(ctx, { org, form, error: result.message }), 200));
}

// ---------------------------------------------------------------------------
// The wave-14 org labels family (pages/org-labels.tsx — the brief's literal
// /{org}/labels page + upstream's /labels/{new,edit,delete} POST segments)
// ---------------------------------------------------------------------------

/**
 * GET /{org}/labels (pages/org-labels.tsx — the management list + create
 * form). The org-teams prologue is family-agnostic (session → org resolve →
 * the requireOrgOwnership gate) and serves unchanged: an anonymous viewer
 * 303s onto the login round-trip, a signed-in non-owner 404-shells (the
 * upstream page sits in the "require owner permission" org group), a renamed
 * org 307s onto the new name.
 */
async function orgLabelsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, respond } = resolved;
  if (resolved.route.family !== "org-labels") return respond(await c.notFound()); // drift guard
  const data = await loadOrgLabelsData(c.env.DB, resolved.org, url.searchParams);
  return respond(c.html(renderOrgLabelsPage({ ctx, data, form: { title: "", color: NEW_LABEL_DEFAULT_COLOR }, error: null }), 200));
}

/**
 * POST /{org}/labels/new (upstream org.NewLabel over the landed create arm):
 * the §2.8 Origin guard, the shared prologue, then `normalizeLabelColor` +
 * `createOrgLabel` — success 303s back onto the list (upstream
 * JSONRedirect's target), the empty-title guard and the color 422 re-render
 * at 200 with the message and the kept submission (the login failure
 * convention).
 */
async function orgLabelNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-label-new") return respond(await c.notFound()); // drift guard
  const form = parseOrgLabelForm(await readUrlEncodedForm(c.req.raw));
  const result = await createOrgLabelFromForm(c.env.DB, org.id, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/labels` } }));
  }
  const data = await loadOrgLabelsData(c.env.DB, org, new URLSearchParams());
  return respond(c.html(renderOrgLabelsPage({ ctx, data, form, error: result.message }), 200));
}

/**
 * POST /{org}/labels/edit (upstream org.UpdateLabel over the landed edit
 * arm's order — the org-scoped lookup before any color 422): success 303s
 * back onto the list; a missing/foreign id 404-shells (the landed PATCH
 * arm's plain "not found"); the failures re-render with the error banner
 * and the STORED row values (pages/org-labels.tsx's re-render note).
 */
async function orgLabelEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-label-edit") return respond(await c.notFound()); // drift guard
  const params = await readUrlEncodedForm(c.req.raw);
  const form = parseOrgLabelForm(params);
  const result = await editOrgLabelFromForm(c.env.DB, org.id, formLabelId(params.get("id")), form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/labels` } }));
  }
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadOrgLabelsData(c.env.DB, org, new URLSearchParams());
  return respond(c.html(renderOrgLabelsPage({ ctx, data, form: { title: "", color: NEW_LABEL_DEFAULT_COLOR }, error: result.message }), 200));
}

/**
 * POST /{org}/labels/delete (upstream org.DeleteLabel over the landed
 * delete arm): the cascade delete when the org-scoped row exists, SUCCESS
 * either way (the arm's zero-row 204) — both arms 303 back onto the list.
 */
async function orgLabelDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-label-delete") return respond(await c.notFound()); // drift guard
  const params = await readUrlEncodedForm(c.req.raw);
  await deleteOrgLabelFromForm(c.env.DB, org.id, formLabelId(params.get("id")));
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/labels` } }));
}

// ---------------------------------------------------------------------------
// The wave-49 org settings + team-edit family (pages/org-settings.tsx —
// upstream's require-owner /{org} group: web.go:1011's team edit/delete and
// web.go:1017-1092's /settings subtree)
// ---------------------------------------------------------------------------

/**
 * GET /{org}/settings (pages/org-settings.tsx — the options page: the
 * profile form, the avatar pair and the danger zone). The org-teams
 * prologue is family-agnostic and serves unchanged: anonymous 303s onto the
 * login round-trip, a signed-in non-owner 404-shells (upstream's
 * RequireOwner OrgAssignment NotFound), a renamed org 307s onto the new
 * name.
 */
async function orgSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-settings") return respond(await c.notFound()); // drift guard
  return respond(c.html(renderOrgSettingsPage(ctx, { org: resolved.org, error: null }), 200));
}

/**
 * POST /{org}/settings (upstream SettingsPost, routers/web/org/setting.go:61-99
 * over the landed orgEdit arm): the §2.8 Origin guard, the shared prologue,
 * then `editOrgProfile` — the form's exact fields (empty clears, the Go
 * empty-pointer semantics). Success 303s back onto the page (upstream's
 * redirect); no server-side validation arms exist to re-render (the
 * EditOrgOption binding note).
 */
async function orgSettingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-settings") return respond(await c.notFound()); // drift guard
  const form = parseOrgSettingsForm(await readUrlEncodedForm(c.req.raw));
  await applyOrgSettingsForm(c.env.DB, org, form);
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings` } }));
}

/**
 * POST /{org}/settings/avatar (upstream SettingsAvatar over the landed
 * avatar store — the API arm's decode→process→store body): the §2.8 guard,
 * the prologue, the multipart parse, then `storeOrgAvatar`. Both arms
 * redirect back silently (upstream Flash.Error/Success + unconditional
 * redirect; no session-flash plumbing — the user-settings reduction).
 */
async function orgSettingsAvatarSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-settings-avatar") return respond(await c.notFound()); // drift guard
  const upload = await readOrgAvatarUpload(c.req.raw);
  if (upload.outcome === "applied") {
    await storeOrgAvatar(c.env.REPO_PACKS, c.env.DB, org, upload);
  }
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings` } }));
}

/**
 * POST /{org}/settings/avatar/delete (upstream SettingsDeleteAvatar over the
 * landed deleteAvatar): the delete is a success no-op on a missing object
 * (the API arm's tolerance); the redirect is unconditional.
 */
async function orgSettingsAvatarDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-settings-avatar-delete") return respond(await c.notFound()); // drift guard
  await deleteOrgAvatar(c.env.REPO_PACKS, c.env.DB, org);
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings` } }));
}

/**
 * POST /{org}/settings/rename (upstream SettingsRenamePost over the landed
 * renameOrg service): the §2.8 guard, the prologue, then the confirmation +
 * no-change guards and the name rules — the failures re-render the settings
 * page at 200 with the upstream banner text (upstream JSONError into the
 * modal form; the org-labels typed-422 convention), success 303s onto the
 * RENAMED org's settings page (upstream's JSONRedirect target).
 */
async function orgSettingsRenameSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-settings-rename") return respond(await c.notFound()); // drift guard
  const form = parseOrgRenameForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyOrgRenameForm(c.env.DB, org, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${result.org.username}/settings` } }));
  }
  return respond(c.html(renderOrgSettingsPage(ctx, { org, error: result.message }), 200));
}

/**
 * POST /{org}/settings/delete (upstream SettingsDeleteOrgPost over the
 * landed orgDelete cascade): the §2.8 guard, the prologue, then the
 * confirmation guard and the still-owns-repos refusal — the failures
 * re-render at 200 with the banner (upstream JSONError); success 303s onto
 * the site root (upstream's JSONRedirect target — the org is gone).
 */
async function orgSettingsDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-settings-delete") return respond(await c.notFound()); // drift guard
  const form = parseOrgDeleteForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyOrgDeleteForm(c.env.DB, org, form);
  if (result.outcome === "deleted") {
    return respond(new Response(null, { status: 303, headers: { location: `/` } }));
  }
  return respond(c.html(renderOrgSettingsPage(ctx, { org, error: result.message }), 200));
}

/**
 * POST /{org}/settings/visibility (upstream SettingsChangeVisibilityPost
 * over the landed orgEdit's `visibility` key): the §2.8 guard, the
 * prologue, then the write — the unchanged and out-of-enum values answer
 * upstream's redirect arms (nothing-has-been-changed / invalid_data), both
 * silent here (no flash plumbing); every arm 303s back onto the page.
 */
async function orgSettingsVisibilitySubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-settings-visibility") return respond(await c.notFound()); // drift guard
  const visibility = parseOrgVisibilityForm(await readUrlEncodedForm(c.req.raw));
  await applyOrgVisibilityForm(c.env.DB, org, visibility);
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings` } }));
}

// ---------------------------------------------------------------------------
// The wave-53 org settings hooks tab (pages/org-settings-hooks.tsx —
// upstream's web.go:1033-1044 /hooks group: org.Webhooks + org.DeleteWebhook
// over the landed owner-scoped arms, and the shared WebHooksEdit /
// GiteaHooksEditPost org-scope shapes)
// ---------------------------------------------------------------------------

/**
 * GET /{org}/settings/hooks (pages/org-settings-hooks.tsx — the webhooks
 * list + add form over the landed `listOwnerHooks` arm). The org-teams
 * prologue is family-agnostic and serves unchanged: anonymous 303s onto the
 * login round-trip, a signed-in non-owner 404-shells (upstream's
 * RequireOwner OrgAssignment NotFound), a renamed org 307s onto the new name.
 */
async function orgHooksSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-settings-hooks") return respond(await c.notFound()); // drift guard
  const data = await loadOrgHooksSettings(c.env.DB, resolved.org);
  return respond(c.html(renderOrgHooksSettingsPage({ ctx, data, error: null }), 200));
}

/**
 * POST /{org}/settings/hooks (upstream's addWebhookAddRoutes reduced to the
 * single landed provider — pages/org-settings-hooks.tsx's header — over the
 * landed `createOwnerHook`, the orgCreateHook API arm's service): the §2.8
 * Origin guard, the shared prologue, then the write — the
 * checkCreateHookOption 422s re-render the list at 200 with the message and
 * the kept submission (the repo hooks-page convention), success 303s back
 * onto the list (upstream's redirect arm).
 */
async function orgHooksSettingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-settings-hooks") return respond(await c.notFound()); // drift guard
  const form = parseCreateHookForm(await readUrlEncodedForm(c.req.raw));
  const result = await createOrgHookFromForm(c.env.DB, org, form);
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/hooks` } }));
  }
  const data = await loadOrgHooksSettings(c.env.DB, org);
  data.form = { name: form.name, payloadUrl: form.payloadUrl, contentType: form.contentType };
  return respond(c.html(renderOrgHooksSettingsPage({ ctx, data, error: result.message }), 200));
}

/**
 * GET /{org}/settings/hooks/{id} (pages/org-settings-hooks.tsx — the edit
 * page over the landed `getOwnerHook` arm): the shared prologue, the drift
 * guard, then the org-scoped hook read — an unknown or foreign-org id
 * 404-shells (the landed DELETE arm's 404, existence stays hidden).
 */
async function orgHookDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-settings-hook-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const data = await loadOrgHookDetailData(c.env.DB, resolved.org, route.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderOrgHookDetailPage({ ctx, data, error: null }), 200));
}

/**
 * POST /{org}/settings/hooks/{id} — the edit write (upstream
 * GiteaHooksEditPost's org-scope shape over the landed PATCH arm's service —
 * `editRepoHook` is scope-agnostic by construction and the org API arm calls
 * the very same function, routes/hooks-scopes.ts:521): the §2.8 guard, the
 * shared prologue, the org-scoped hook read, then the form write — the 422
 * validations re-render at 200 with the message and the kept submission (the
 * repo hooks-page convention), success 303s back onto the page (upstream
 * editWebhook's redirect). The POST rides the page URL — upstream
 * type-prefixes it (`/gitea/{id}`); the repo page's divergence note.
 */
async function orgHookDetailSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-settings-hook-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const hook = await getOwnerHook(c.env.DB, org.id, route.id);
  if (hook === null) return respond(c.html(renderNotFound(ctx), 404));
  const hookLink = `/${org.username}/settings/hooks/${hook.id}`;
  const form = parseHookEditForm(await readUrlEncodedForm(c.req.raw));
  const result = await editHookFromForm(c.env.DB, hook, form);
  if (result.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: hookLink } }));
  }
  const data = await loadOrgHookDetailData(c.env.DB, org, hook.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  data.form = form;
  return respond(c.html(renderOrgHookDetailPage({ ctx, data, error: result.message }), 200));
}

/**
 * POST /{org}/settings/hooks/{id}/delete — upstream DeleteWebhook's org arm
 * (org/setting.go:175-187) over the landed `deleteOwnerHook` (the arm-scoped
 * tail — the repo hooks-page convention, the module header): success 303s
 * onto the hooks list (upstream JSONRedirect's target); a miss 404-shells
 * (the landed DELETE arm's 404 — existence stays hidden).
 */
async function orgHookDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-settings-hook-delete" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const deleted = await deleteOrgHook(c.env.DB, org, route.id);
  if (!deleted) return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/hooks` } }));
}

// ---------------------------------------------------------------------------
// Window-2b: the org blocked-users tab + the actions secrets/variables
// sub-tabs (the two-stage modules' handoff recipes — same prologue, drift
// guards, sameOriginGuard-first POSTs).
// ---------------------------------------------------------------------------

async function orgBlockedUsersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-settings-blocked") return respond(await c.notFound()); // drift guard
  const data = await loadOrgBlockedUsers(c.env.DB, resolved.org);
  return respond(c.html(renderOrgBlockedUsersPage({ ctx, data, error: null }), 200));
}

async function orgBlockedUsersSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, viewer, respond } = resolved;
  if (resolved.route.family !== "org-settings-blocked") return respond(await c.notFound()); // drift guard
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the prologue's silent-auth-failure convention
  const form = parseOrgBlockedForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyOrgBlockedForm(c.env.DB, org, { id: viewer.id, isAdmin: viewer.isAdmin }, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/blocked_users` } }));
  }
  const data = await loadOrgBlockedUsers(c.env.DB, org);
  return respond(c.html(renderOrgBlockedUsersPage({ ctx, data, error: result.message }), 200));
}

async function orgActionsSecretsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-actions-secrets") return respond(await c.notFound()); // drift guard
  const data = await loadOrgActionsSecretsPageData(c.env.DB, resolved.org);
  return respond(c.html(renderOrgActionsSecretsPage(ctx, data), 200));
}

async function orgActionsSecretsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-secrets") return respond(await c.notFound()); // drift guard
  const form = parseOrgActionsSecretForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyOrgActionsSecretForm(c.env.DB, org.id, form);
  if (outcome.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/secrets` } }));
  }
  const data = await loadOrgActionsSecretsPageData(c.env.DB, org);
  // Carried name/description only — plaintext never enters the DOM.
  data.form = { name: form.name, data: "", description: form.description };
  return respond(c.html(renderOrgActionsSecretsPage(ctx, data, outcome.message)));
}

async function orgActionsSecretsDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-actions-secrets-delete") return respond(await c.notFound()); // drift guard
  const form = parseOrgActionsSecretDeleteForm(await readUrlEncodedForm(c.req.raw));
  await deleteOrgActionsSecret(c.env.DB, org.id, form);
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/secrets` } }));
}

async function orgActionsVariablesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-actions-variables") return respond(await c.notFound()); // drift guard
  const data = await loadOrgActionsVariablesPageData(c.env.DB, resolved.org);
  return respond(c.html(renderOrgActionsVariablesPage(ctx, data), 200));
}

async function orgActionsVariablesNew(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-variables-new") return respond(await c.notFound()); // drift guard
  const form = parseOrgActionsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyOrgActionsVariableCreate(c.env.DB, org.id, form);
  if (outcome.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/variables` } }));
  }
  const data = await loadOrgActionsVariablesPageData(c.env.DB, org);
  if (outcome.outcome === "invalid") {
    data.form = { name: form.name, data: form.data, description: form.description };
    return respond(c.html(renderOrgActionsVariablesPage(ctx, data, outcome.message)));
  }
  return respond(c.html(renderNotFound(ctx), 404));
}

async function orgActionsVariablesEdit(c: Context<{ Bindings: Env }>, variableId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-variables-edit") return respond(await c.notFound()); // drift guard
  const form = parseOrgActionsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyOrgActionsVariableUpdate(c.env.DB, org.id, variableId, form);
  if (outcome.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/variables` } }));
  }
  if (outcome.outcome === "missing") {
    // Upstream's findActionsVariable miss → ctx.NotFound(nil) — a genuine
    // 404 (the module handoff's fidelity call).
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const data = await loadOrgActionsVariablesPageData(c.env.DB, org);
  data.form = { name: form.name, data: form.data, description: form.description };
  return respond(c.html(renderOrgActionsVariablesPage(ctx, data, outcome.message)));
}

async function orgActionsVariablesDelete(c: Context<{ Bindings: Env }>, variableId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-variables-delete") return respond(await c.notFound()); // drift guard
  const outcome = await deleteOrgActionsVariable(c.env.DB, org.id, variableId);
  if (outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/variables` } }));
}

// ---------------------------------------------------------------------------
// Window-2c: the admin pages (pages/admin-dashboard.tsx +
// pages/admin-monitor.tsx — upstream's SignInRequired+AdminRequired gate,
// web.go:779: anonymous 303s onto the login round-trip, a signed-in
// non-admin 404-shells (upstream's NotFound posture for hidden admin
// surfaces).
// ---------------------------------------------------------------------------

/** The shared admin prologue: session → gates, answering {ctx, respond}
 *  or a terminal Response. */
async function adminPagePrologue(c: Context<{ Bindings: Env }>): Promise<
  { ok: true; ctx: UiContext; respond: (r: Response, status?: number) => Response } | { ok: false; response: Response }
> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return { ok: false, response: resolved.response };
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return { ok: false, response: respond(loginRedirect(url.pathname)) };
  if (!viewer.isAdmin) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  return { ok: true, ctx, respond };
}

async function adminDashboardPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminDashboardData(new Date());
  return p.respond(c.html(renderAdminDashboardPage({ ctx: p.ctx, data, flash: null })));
}

async function adminDashboardSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminDashboardForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyAdminDashboardForm(c.env, form);
  // Upstream redirects; with no flash queue the module's recipe re-renders
  // fresh at 200 with the flash (the handoff's documented reduction).
  const data = await loadAdminDashboardData(new Date());
  const flash = { kind: result.outcome === "applied" ? "positive" as const : "negative" as const, text: result.message };
  return p.respond(c.html(renderAdminDashboardPage({ ctx: p.ctx, data, flash })));
}

async function adminMonitorPage(c: Context<{ Bindings: Env }>, page: AdminMonitorPage): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  switch (page) {
    case "stats": {
      const data = await loadAdminMonitorStats(c.env.DB);
      return p.respond(c.html(renderAdminMonitorStatsPage({ ctx: p.ctx, data })));
    }
    case "cron": {
      const data = { entries: loadAdminMonitorCron(new Date()).entries };
      return p.respond(c.html(renderAdminMonitorCronPage({ ctx: p.ctx, data, flash: null })));
    }
    case "queue": {
      const data = await loadAdminMonitorQueues(c.env.DB);
      return p.respond(c.html(renderAdminMonitorQueuePage({ ctx: p.ctx, data })));
    }
    case "trace":
      return p.respond(c.html(renderAdminMonitorTracePage({ ctx: p.ctx })));
  }
}

async function adminMonitorCronSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminMonitorCronForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyAdminMonitorCronForm(c.env, form);
  const data = { entries: loadAdminMonitorCron(new Date()).entries };
  const flash = { kind: result.outcome === "applied" ? "positive" as const : "negative" as const, text: result.message };
  return p.respond(c.html(renderAdminMonitorCronPage({ ctx: p.ctx, data, flash })));
}

/**
 * GET /{org}/teams/{id}/edit (pages/org-settings.tsx — upstream EditTeam,
 * routers/web/org/teams.go:495-510, tplTeamNew's edit arm): the org-teams
 * prologue, then the org-scoped team read — an unknown or foreign-org id
 * 404-shells (the detail slice's foreign-id rule).
 */
async function orgTeamEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-team-edit" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const team = await loadOrgTeamEditData(c.env.DB, resolved.org, route.id);
  if (team === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    c.html(renderOrgTeamEditPage(ctx, { org: resolved.org, team, form: teamEditFormFromTeam(team), error: null }), 200),
  );
}

/**
 * POST /{org}/teams/{id}/edit (upstream EditTeamPost over the landed
 * orgEditTeam arm): the §2.8 guard, the prologue, the org-scoped team read,
 * then the form write — the required-name and rename-collision failures
 * re-render at 200 with the banner and the submitted values (upstream's
 * RenderWithErr arms), success 303s onto the team's detail slice (upstream
 * redirects onto /teams/{lowername}; the slice keys on the id — the
 * org-teams route-shape note).
 */
async function orgTeamEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-team-edit" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const team = await loadOrgTeamEditData(c.env.DB, org, route.id);
  if (team === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseOrgTeamEditForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyOrgTeamEditForm(c.env.DB, team, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/teams/${team.id}` } }));
  }
  return respond(c.html(renderOrgTeamEditPage(ctx, { org, team, form, error: result.message }), 200));
}

/**
 * POST /{org}/teams/{id}/delete (upstream DeleteTeam over the landed
 * orgDeleteTeam cascade): the §2.8 guard, the prologue, the org-scoped team
 * read, then the write — success 303s onto the teams list (upstream's
 * JSONRedirect target); the last-owner refusal 303s back onto the edit form
 * (upstream Flash.Error + the same unconditional redirect — no flash
 * plumbing, so the arms differ only in target).
 */
async function orgTeamDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-team-delete" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const team = await loadOrgTeamEditData(c.env.DB, org, route.id);
  if (team === null) return respond(c.html(renderNotFound(ctx), 404));
  const result = await applyOrgTeamDelete(c.env.DB, team);
  const location =
    result.outcome === "deleted" ? `/${org.username}/teams` : `/${org.username}/teams/${team.id}/edit`;
  return respond(new Response(null, { status: 303, headers: { location } }));
}

// ---------------------------------------------------------------------------
// The wave-8 file editor (pages/file-editor.tsx — upstream's
// _new/_edit/_delete editor Combos, web.go:1453-1461)
// ---------------------------------------------------------------------------

/** Parse family → page mode. */
const FILE_EDITOR_MODES = {
  "file-new": "new",
  "file-edit": "edit",
  "file-delete": "delete",
} as const;

/**
 * The editor prologue the GET and POST share (after the POST's §2.8 Origin
 * guard, and after each handler's own family drift check): the repo
 * resolution (invisible repos 404-shell before any redirect could leak
 * them), the anonymous login 303, then the write posture — the archived
 * refusal (upstream `RepoMustNotBeArchived` answers NotFound,
 * services/context/repo.go:136-141) and the write predicate (`canWriteRepo`,
 * the UI delegate onto the landed canWriteRepository, repo-access.ts via
 * ../repo-grants.ts — team grants included; non-writers
 * 404-shell like the settings pages — no fork-to-edit flow exists to offer
 * readers). Returns the ready Response, or null to proceed.
 */
async function fileEditorGate(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
): Promise<Response | null> {
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (repo.isArchived || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  return null;
}

/** GET /{owner}/{repo}/{new|edit|delete}/{branch}[/{path}] (the form;
 *  `?filename=` prefills the new-file name input — upstream 303s onto the
 *  path URL instead, editor.go:274-284, the header's documented
 *  simplification). */
async function fileEditorPage(c: Context<{ Bindings: Env }>, family: FileEditorRoute["family"]): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== family) return respond(await c.notFound()); // registration/parser drift guard
  const gate = await fileEditorGate(c, resolved);
  if (gate !== null) return gate;
  const mode = FILE_EDITOR_MODES[family];
  const engine = engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`);
  const data = await loadFileEditorData(engine, repo, mode, route.refSuffix, url.searchParams.get("filename"));
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderFileEditorPage({ ctx, data, form: editorFormFromData(data), error: null }), 200));
}

/**
 * POST /{owner}/{repo}/{new|edit|delete}/{branch}[/{path}] (upstream
 * EditFilePost / DeleteFilePost): the §2.8 layer-2 Origin guard FIRST, then
 * the GET's prologue, then the landed `applyFileChanges` through
 * `commitFileFromForm` — author = committer = the session viewer, the
 * blob-sha hidden field arming the service's CAS, the push-webhook family
 * riding the applied delta (pages/file-editor.tsx module header). A refused
 * edit (binary / too large — the GET's NotEditableReason) re-renders the
 * refusal; success 303s onto the file view on the target branch (upstream
 * redirectForCommitChoice's tail, editor.go:227-230; the delete lands on
 * the containing tree); every service arm re-renders the form at 200 with
 * the message and the submitted values (the login failure convention).
 */
async function fileEditorSubmit(c: Context<{ Bindings: Env }>, family: FileEditorRoute["family"]): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== family) return respond(await c.notFound()); // registration/parser drift guard
  const gate = await fileEditorGate(c, resolved);
  if (gate !== null) return gate;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const mode = FILE_EDITOR_MODES[family];
  const engine = engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`);
  const data = await loadFileEditorData(engine, repo, mode, route.refSuffix, url.searchParams.get("filename"));
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  const values = await readEditorForm(c.req.raw);
  if (data.notEditableReason !== null) {
    // The refusal stands on POST too (upstream's content-absent degenerate
    // arm — editor.go:345-357 — reduced to the page's own message).
    return respond(c.html(renderFileEditorPage({ ctx, data, form: editorFormFromData(data), error: null }), 200));
  }
  const result = await commitFileFromForm(c.env, c.req.raw, repo, userRow, mode, values);
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  if (result.outcome === "committed") {
    const branchPart = `${repoLink}/src/branch/${pathEscapeSegments(result.branch)}`;
    const location =
      mode === "delete"
        ? result.treePath.includes("/")
          ? `${branchPart}/${pathEscapeSegments(result.treePath.slice(0, result.treePath.lastIndexOf("/")))}`
          : branchPart
        : `${branchPart}/${pathEscapeSegments(result.treePath)}`;
    return respond(new Response(null, { status: 303, headers: { location } }));
  }
  return respond(c.html(renderFileEditorPage({ ctx, data, form: values, error: result.message }), 200));
}

/**
 * GET / — the site root (pages/dashboard.tsx — upstream `Home`,
 * routers/web/home.go:26-44): the session prologue WITHOUT the repo read,
 * then the viewer-kind dispatch — a signed-in viewer gets the dashboard
 * (pages wave 9: the derived-thread activity lines + the own/watched repo
 * lists), an anonymous viewer the upstream landing page. Only the manifest
 * half can fail here (the 503); the page reads degrade per their loaders.
 */
async function siteHomePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, respond } = resolved;
  if (viewer.kind === "user") {
    const data = await loadDashboardData(c.env.DB, viewer);
    return respond(c.html(renderDashboardPage(ctx, data), 200));
  }
  return respond(c.html(renderLandingPage(ctx), 200));
}

/**
 * GET /explore — upstream web.go:550-552: a plain redirect onto the repos
 * page (upstream ctx.Redirect, 303 per base.go:157).
 */
function exploreRoot(): Response {
  return new Response(null, { status: 303, headers: { location: "/explore/repos" } });
}

/** GET /explore/repos (pages/explore.tsx — the repo search page; anonymous
 *  sees public rows, a session viewer gains their own private repos — the
 *  upstream `Private: ctx.Doer != nil` scope in the search service seam). */
async function exploreReposPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  const data = await loadExploreReposData(c.env.DB, viewer, url.searchParams);
  return respond(c.html(renderExploreReposPage(ctx, data), 200));
}

/** GET /explore/users (pages/explore.tsx — the user search page; the
 *  landed user-search predicate + the upstream Types/IsActive gates). */
async function exploreUsersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, respond } = resolved;
  const data = await loadExploreUsersData(c.env.DB, url.searchParams);
  return respond(c.html(renderExploreUsersPage(ctx, data), 200));
}

// ---------------------------------------------------------------------------
// The wave-10 notifications family (pages/notifications.tsx — upstream
// web.go:1784-1791's reqSignIn group)
// ---------------------------------------------------------------------------

/** GET /notifications — upstream Notifications (user/notification.go:38-46):
 *  the signed-in mailbox; anonymous 303s onto the login round-trip. The
 *  `?div-only=1` arm answers the bare `#notification_div` fragment the
 *  official bundle's live table refresh fetches (features/notification.ts). */
async function notificationsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const pageType = parseNotificationPageType(url.searchParams.get("type"));
  const page = parsePageNumber(url.searchParams.get("page"));
  const sequenceNumber = url.searchParams.get("sequence-number") ?? "";
  // The navbar resolution already computed the unread count for this
  // request — one COUNT, not two (pages/notifications.tsx loader).
  const data = await loadNotificationsData(c.env.DB, viewer.id, pageType, page, ctx.notificationCount ?? undefined);
  if (parseFormBool(url.searchParams.get("div-only"))) {
    return respond(c.html(renderNotificationDiv(data, sequenceNumber), 200));
  }
  return respond(c.html(renderNotificationsPage(ctx, data, sequenceNumber), 200));
}

/** GET /notifications/new — upstream NewAvailable (notification.go:433-446):
 *  the unread count as `{new: N}` JSON for the bundle's live badge; a failed
 *  read degrades `{new: 0}` exactly like upstream's error arm. */
async function notificationsNew(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const count = await countUnreadNotifications(c.env.DB, viewer.id).catch(() => 0);
  return respond(c.json({ new: count }, 200));
}

/**
 * POST /notifications/status — upstream NotificationStatusPost
 * (notification.go:167-189): the per-row status write (mark_as_read /
 * mark_as_unread / pin through the landed SetNotificationStatus semantics),
 * then the FRESH DIV FRAGMENT as the answer (upstream renders
 * tplNotificationDiv; the bundle's fetch-action JS morphs it into the page
 * via the form's `data-fetch-sync`). An id that is not the caller's mailbox
 * thread 404-shells (the landed API PATCH's miss family — existence hidden;
 * upstream answers ServerError here, the documented divergence), an unknown
 * action is ignored with an empty 200 (upstream `default: return`).
 */
async function notificationStatusSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const { id, action } = parseNotificationStatusForm(await readUrlEncodedForm(c.req.raw));
  if (action === null) {
    // Unknown action — ignored with an empty 200 (upstream `default: return`).
    return respond(new Response(null, { status: 200 }));
  }
  const marked = await markNotificationThread(c.env.DB, viewer.id, { id, action }, new Date());
  if (!marked) return respond(c.html(renderNotFound(ctx), 404));
  // The re-render keeps the current query's tab/page/sequence (upstream
  // prepareUserNotificationsData over the posted PageQueryParams).
  const pageType = parseNotificationPageType(url.searchParams.get("type"));
  const page = parsePageNumber(url.searchParams.get("page"));
  const sequenceNumber = url.searchParams.get("sequence-number") ?? "";
  const data = await loadNotificationsData(c.env.DB, viewer.id, pageType, page);
  return respond(c.html(renderNotificationDiv(data, sequenceNumber), 200));
}

/**
 * POST /notifications/purge — upstream NotificationPurgePost
 * (notification.go:191-199): every unread thread marked read, answered with
 * the JSONRedirect shape (`{"redirect": …}`, context.go:239-241) the
 * bundle's link-action JS follows.
 */
async function notificationPurgeSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  await purgeNotifications(c.env.DB, viewer.id, new Date());
  return respond(c.json({ redirect: "/notifications" }, 200));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/comments (pages/issue-detail.tsx
 * — upstream NewComment, routers/web/repo/issue_comment.go:37-118): the §2.8
 * Origin guard, the same repo→viewer order as the GET pages (invisible repos
 * 404 before the redirect could leak them), then the landed
 * `IssuesService.addComment` (+ the `status` close/reopen through
 * closeIssue/reopenIssue). Success 303s onto the row's OWN family page with
 * the `#issuecomment-{id}` anchor when a comment was created (upstream
 * `redirect += "#" + comment.HashTag()`); validation failures re-render the
 * detail page at 200 with the message and the kept draft (the login failure
 * convention).
 */
async function issueCommentSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-comment") return respond(await c.notFound()); // registration/parser drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));

  const issue = await findIssueByRepoAndIndex(c.env.DB, repo.id, route.index);
  if (issue === null) return respond(c.html(renderNotFound(ctx), 404));
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  // The redirect target is the ROW's own family (upstream issueType,
  // issue_comment.go:70) — a POST through the twin family still lands
  // canonically. The cross-family GET redirect stays the detail route's.
  const canonicalPath = `${repoLink}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`;

  const form = parseCommentForm(await readUrlEncodedForm(c.req.raw));
  // The merged-PR guard needs the PR extension row only.
  const pr = issue.isPull ? ((await findPullRequestByIndex(c.env.DB, repo.id, route.index))?.pullRequest ?? null) : null;
  const access = await resolveIssueDetailAccess(c.env, repo, viewer, issue);
  const result = await createCommentFromForm(c.env.DB, repo, issue, pr, viewer, access, form);
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `${canonicalPath}#issuecomment-${result.comment.id}` } }));
  }
  if (result.outcome === "state-only") {
    return respond(new Response(null, { status: 303, headers: { location: canonicalPath } }));
  }
  // Re-render with the message and the kept draft (the new-issue convention).
  const data = await loadIssueDetailData(c.env.DB, repo, route.urlKind, route.index, url.origin, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderIssueDetailPage(ctx, data, access, { content: form.content, error: result.message }), 200));
}

/**
 * POST /{owner}/{repo}/issues/labels (pages/issue-detail.tsx — the sidebar
 * label edit): admin viewers only (`canAdminRepo` — the settings predicate;
 * anonymous 303s onto the login round-trip, a signed-in non-admin 404-
 * shells). The submitted `label_ids` set REPLACES the issue's labels through
 * the landed `IssuesService.replaceLabels` (diff-based attach/detach with
 * the counter maintenance); success 303s onto the issue's canonical page,
 * the service's NoSuchLabel message re-renders inline.
 */
async function issueLabelsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (!(await canAdminRepo(c.env, repo, viewer))) return respond(c.html(renderNotFound(ctx), 404));

  const form = parseIssueLabelForm(await readUrlEncodedForm(c.req.raw));
  // The issue_ids selector scopes GLOBAL label ids to THIS repo's issues
  // (upstream getActionIssues' repo check) — a foreign id 404-shells.
  const issue = form.issueId === null ? null : await new IssuesService(c.env.DB).getIssueById(form.issueId);
  if (issue === null || issue.repoId !== repo.id) return respond(c.html(renderNotFound(ctx), 404));

  const result = await applyIssueLabels(c.env.DB, issue, form);
  const canonicalPath = `/${repo.ownerNamespace}/${repo.slug}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`;
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: canonicalPath } }));
  }
  const data = await loadIssueDetailData(c.env.DB, repo, issue.isPull ? "pulls" : "issues", issue.index, url.origin, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const access = await resolveIssueDetailAccess(c.env, repo, viewer, issue);
  return respond(c.html(renderIssueDetailPage(ctx, data, access, { content: "", error: result.message }), 200));
}

/**
 * POST /{owner}/{repo}/pulls/{index}/files/reviews/submit (pages/
 * pull-reviews.tsx — upstream SubmitReview, routers/web/repo/pull_review.go
 * :222-270 over the landed create-review arm's pipeline): the §2.8 Origin
 * guard, the repo→viewer order, then the landed SubmitReview port — the
 * verdict select maps approve/comment/reject onto the wire events, the
 * poster's self-approval/self-rejection and the REQUEST_CHANGES body
 * requirement 422 the same messages, the head tip resolves the absent
 * commit, the CommentTypeReview system comment lands with the review, and
 * the webhook family rides the write. Success 303s onto
 * `pulls/{index}#issuecomment-{id}` (upstream JSONRedirect's
 * `comm.HashTag()` target — CommentHashTag, comment.go:554-556); the
 * re-render carries the message + kept draft (the login failure convention).
 */
async function pullReviewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "pull-review-submit" || route.index === undefined) return respond(await c.notFound());
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  // RepoMustNotBeArchived wraps upstream's reviews group (web.go:1677).
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404));

  const issue = await findIssueByRepoAndIndex(c.env.DB, repo.id, route.index);
  if (issue === null || !issue.isPull) return respond(c.html(renderNotFound(ctx), 404)); // upstream `if !issue.IsPull`
  const joined = await findPullRequestByIndex(c.env.DB, repo.id, route.index);
  if (joined === null) return respond(c.html(renderNotFound(ctx), 404));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));

  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const form = parseReviewSubmitForm(await readUrlEncodedForm(c.req.raw));
  try {
    const result = await submitReviewFromForm({
      request: c,
      origin: url.origin,
      pair,
      repo,
      issue,
      pr: joined.pullRequest,
      doerId: viewer.id,
      form,
    });
    return respond(
      new Response(null, { status: 303, headers: { location: `${repoLink}/pulls/${issue.index}#issuecomment-${result.commentId}` } }),
    );
  } catch (error) {
    const message = pullReviewErrorMessage(error);
    if (message === null) throw error;
    const data = await loadIssueDetailData(c.env.DB, repo, "pulls", route.index, url.origin, viewer);
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    const access = await resolveIssueDetailAccess(c.env, repo, viewer, data.issue);
    return respond(c.html(renderIssueDetailPage(ctx, data, access, undefined, { content: form.content, error: message }), 200));
  }
}

/**
 * POST /{owner}/{repo}/issues/request_review (pages/pull-reviews.tsx —
 * upstream UpdatePullReviewRequest, routers/web/repo/pull_review.go:339
 * over the landed request arms): the sameOriginGuard + repo→viewer order,
 * the issue resolved from `issue_ids` (the labels-write pattern — upstream
 * getActionIssues' field), then attach (the no-JS `reviewer` NAME through
 * the landed resolver) or detach (upstream's numeric `id`). Success 303s
 * onto the PR's canonical page (the link-action reload upstream's JS
 * performs); failures re-render the PR detail page with the landed message
 * under the Reviewers control (upstream flashes/403s — the re-render is the
 * no-JS convention).
 */
async function pullReviewRequestSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-request-review") return respond(await c.notFound());
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // RepoMustNotBeArchived (web.go:1419-1421)

  const form = parseReviewRequestForm(await readUrlEncodedForm(c.req.raw));
  // The issue_ids selector scopes GLOBAL issue ids to THIS repo (upstream
  // getActionIssues' repo check) — a foreign id or a non-PR 404-shells
  // (upstream answers Status(403) for the non-PR arm; the shell hides it).
  const issue = form.issueId === null ? null : await new IssuesService(c.env.DB).getIssueById(form.issueId);
  if (issue === null || issue.repoId !== repo.id || !issue.isPull) return respond(c.html(renderNotFound(ctx), 404));
  const joined = await findPullRequestByIndex(c.env.DB, repo.id, issue.index);
  if (joined === null) return respond(c.html(renderNotFound(ctx), 404));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));

  const canonicalPath = `/${repo.ownerNamespace}/${repo.slug}/pulls/${issue.index}`;
  try {
    await changeReviewRequestFromForm({
      request: c,
      origin: url.origin,
      pair,
      repo,
      issue,
      pr: joined.pullRequest,
      doerId: viewer.id,
      form,
    });
    return respond(new Response(null, { status: 303, headers: { location: canonicalPath } }));
  } catch (error) {
    const message = pullReviewErrorMessage(error);
    if (message === null) throw error;
    const data = await loadIssueDetailData(c.env.DB, repo, "pulls", issue.index, url.origin, viewer);
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    const access = await resolveIssueDetailAccess(c.env, repo, viewer, data.issue);
    return respond(c.html(renderIssueDetailPage(ctx, data, access, undefined, undefined, message), 200));
  }
}

/** The gate's plain-text error shape (the dismiss arm's non-form states —
 *  upstream's own dismiss handler answers bare statuses, pull_review.go
 *  :288-291). */
function pullReviewStatusError(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/**
 * POST /{owner}/{repo}/issues/dismiss_review (pages/pull-reviews.tsx —
 * upstream DismissReview, routers/web/repo/pull_review.go:280-293 over the
 * landed dismissal arm): the settings predicate stands in for reqRepoAdmin
 * (web.go:1436 — non-admins 404-shell, the settingsGate posture), then the
 * landed port (approve/reject rows only, closed/merged 403, the flag flip,
 * the CommentTypeDismissReview comment). Success 303s onto
 * `pulls/{index}#issuecomment-{id}` (upstream's redirect target).
 */
async function pullReviewDismissSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-dismiss-review") return respond(await c.notFound());
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (!(await canAdminRepo(c.env, repo, viewer))) return respond(c.html(renderNotFound(ctx), 404)); // reqRepoAdmin
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // RepoMustNotBeArchived (web.go:1436's group)

  const form = parseDismissReviewForm(await readUrlEncodedForm(c.req.raw));
  if (form.reviewId === null) return respond(c.html(renderNotFound(ctx), 404));
  try {
    const result = await dismissReviewFromForm({
      request: c,
      repoId: repo.id,
      doerId: viewer.id,
      reviewId: form.reviewId,
      message: form.message,
    });
    return respond(
      new Response(null, {
        status: 303,
        headers: { location: `/${repo.ownerNamespace}/${repo.slug}/pulls/${result.issueIndex}#issuecomment-${result.commentId}` },
      }),
    );
  } catch (error) {
    if (error instanceof PullReviewError) {
      if (error.status === 404) return respond(c.html(renderNotFound(ctx), 404));
      return respond(pullReviewStatusError(error.status, error.message));
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The wave-13 compare family (pages/compare.tsx — upstream's /compare group,
// web.go:1307-1315, CompareDiff + CompareAndPullRequestPost)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/compare[/{base}...{head}] (pages/compare.tsx — the
 *  comparison view; every viewer who can see the repo reads it; the create
 *  form's writer gate rides along as `canCreate` — the branch-kinds arm
 *  (upstream allowCreatePull's IsBranch pair) reads the loaded data, so the
 *  gate computes AFTER the load). */
async function comparePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  // Window-2e B2: the .diff/.patch byte feeds share the compare
  // registration — the parser's compare-feed family branches here before
  // the page drift guard (web.go:1309-1310 vs the page route).
  if (route.family === "compare-feed" && route.segment !== undefined && route.ext !== undefined) {
    const repoFeed: CompareFeedRepo = {
      ownerNamespace: repo.ownerNamespace,
      slug: repo.slug,
      isEmpty: repo.isEmpty,
      defaultBranch: repo.defaultBranch,
    };
  const result = await loadCompareFeed(c.env, repoFeed, route.segment, route.ext);
  if (result.kind === "notFound") return respond(c.html(renderNotFound(ctx), 404));
  if (result.kind === "noMergeBase") return respond(compareFeedServerErrorResponse());
  return respond(compareFeedTextResponse(result.body));
}

  if (route.family !== "compare") return respond(await c.notFound()); // registration/parser drift guard
  const page = parsePageNumber(url.searchParams.get("page"));
  const data = await loadCompareData(c.env, c.env.DB, repo, { base: route.base, head: route.head, page });
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  const canCreate =
    !repo.isArchived &&
    viewer.kind === "user" &&
    data.baseKind === "branch" &&
    data.headKind === "branch" &&
    (await canWriteRepo(c.env, repo, viewer));
  return respond(
    c.html(
      renderComparePage({
        ctx,
        data,
        form: { title: data.suggestedTitle, content: data.suggestedContent },
        error: null,
        canCreate,
        page,
      }),
      200,
    ),
  );
}

// ---------------------------------------------------------------------------
// Window-2e C1: the global inbox pages (pages/global-inbox.tsx) — reqSignIn
// (web.go:567-573): anonymous 303s onto the login round-trip.
// ---------------------------------------------------------------------------

async function globalInboxIssuesPage(c: Context<{ Bindings: Env }>, listKind: "issues" | "pulls"): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, viewer, respond } = resolved;
  const family = listKind === "issues" ? "global-issues" : "global-pulls";
  if (resolved.route.family !== family) return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const data = await loadOverviewIssuesData(c.env.DB, viewer, listKind, url.searchParams);
  return respond(c.html(renderOverviewIssuesPage(resolved.ctx, data), 200));
}

async function globalMilestonesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, viewer, respond } = resolved;
  if (resolved.route.family !== "global-milestones") return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  const data = await loadDashboardMilestonesData(c.env.DB, viewer, url.searchParams);
  return respond(c.html(renderDashboardMilestonesPage(resolved.ctx, data), 200));
}

// ---------------------------------------------------------------------------
// Window-2e C2: the WIKI family (pages/repo-wiki.tsx). The hasWiki gate
// 404-shells disabled wikis (the module handoff); the ?action= form value
// dispatches the sub-pages (the VERIFIED grammar — _pages/_revision are
// FORM-VALUE case-arms in wiki.go, not routes); writes carry sameOriginGuard
// + the writer gate + the archived refusal.
// ---------------------------------------------------------------------------

/** The wiki prologue: repo read, hasWiki gate, and the write-grant pair. */
async function wikiPrologue(
  c: Context<{ Bindings: Env }>,
): Promise<
  | {
      ok: true;
      ctx: UiContext;
      pair: NonNullable<Awaited<ReturnType<typeof findRepositoryById>>>;
      repo: RepoRow;
      rawTail: string;
      canWrite: boolean;
      doer: WikiDoer;
      respond: (r: Response, status?: number) => Response;
    }
  | { ok: false; response: Response }
> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return { ok: false, response: resolved.response };
  const { ctx, repo, viewer, respond } = resolved;
  if (resolved.route.family !== "wiki") return { ok: false, response: respond(await c.notFound()) }; // drift guard
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  if (!settings.hasWiki) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  if (viewer.kind !== "user") {
    return { ok: true, ctx, pair, repo, rawTail: resolved.route.rawTail, canWrite: false, doer: { name: "", email: "" }, respond };
  }
  // The commit identity (the editor family's convention: stored email or
  // the noreply fallback).
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  const email = userRow.email === null || userRow.email === "" ? `${userRow.username}@noreply.${new URL(c.req.url).hostname}` : userRow.email;
  return {
    ok: true,
    ctx,
    pair,
    repo,
    rawTail: resolved.route.rawTail,
    canWrite: !repo.isArchived && (await canWriteRepo(c.env, repo, viewer)),
    doer: { name: userRow.username, email },
    respond,
  };
}

async function wikiPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await wikiPrologue(c);
  if (!p.ok) return p.response;
  const { ctx, pair, rawTail, canWrite, respond } = p;
  const url = new URL(c.req.url);
  const action = url.searchParams.get("action");
  if (action === "_pages") {
    const data = await loadWikiPagesData(c.env, pair);
    if (data.outcome === "no-wiki") return respond(c.html(renderWikiStartPage({ ctx, canWrite }), 200));
    return respond(c.html(renderWikiPagesPage({ ctx, data, canWrite }), 200));
  }
  if (action === "_revision") {
    const data = await loadWikiRevisionData(c.env, pair, rawTail, url.searchParams.get("page"));
    if (data.outcome === "start") return respond(c.html(renderWikiStartPage({ ctx, canWrite }), 200));
    if (data.outcome === "missing") {
      return respond(new Response(null, { status: 303, headers: { location: wikiPagesAction(p.repo) } }));
    }
    return respond(c.html(renderWikiRevisionPage({ ctx, data }), 200));
  }
  if (action === "_new") {
    if (!canWrite) return respond(c.html(renderNotFound(ctx), 404));
    return respond(c.html(renderWikiNewPage({ ctx, initialTitle: "", error: null }), 200));
  }
  if (action === "_edit") {
    if (!canWrite) return respond(c.html(renderNotFound(ctx), 404));
    const data = await loadWikiEditData(c.env, pair, rawTail, url.origin);
    if (data.outcome === "no-wiki") return respond(c.html(renderWikiStartPage({ ctx, canWrite }), 200));
    if (data.outcome === "missing") {
      return respond(new Response(null, { status: 303, headers: { location: wikiPagesAction(p.repo) } }));
    }
    return respond(c.html(renderWikiEditPage({ ctx, data, error: null }), 200));
  }
  const data = await loadWikiViewData(c.env, pair, rawTail, url.origin);
  if (data.outcome === "start") return respond(c.html(renderWikiStartPage({ ctx, canWrite }), 200));
  if (data.outcome === "missing") {
    return respond(new Response(null, { status: 303, headers: { location: wikiPagesAction(p.repo) } }));
  }
  return respond(c.html(renderWikiViewPage({ ctx, data, canWrite }), 200));
}

function wikiPagesAction(repo: RepoRow): string {
  return `${repoLinkOf(repo)}/wiki/?action=_pages`;
}

async function wikiSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await wikiPrologue(c);
  if (!p.ok) return p.response;
  const { ctx, pair, rawTail, canWrite, doer, repo, respond } = p;
  if (!canWrite) return respond(c.html(renderNotFound(ctx), 404));
  const url = new URL(c.req.url);
  const form = parseWikiPageForm(await readUrlEncodedForm(c.req.raw));
  const action = url.searchParams.get("action");
  try {
    if (action === "_new") {
      const page = await createWikiPageFromForm(c.env, pair, doer, form, url.origin);
      return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/wiki/${page.sub_url}` } }));
    }
    if (action === "_delete") {
      await deleteWikiPageFromForm(c.env, pair, doer, rawTail);
      return respond(new Response(null, { status: 303, headers: { location: wikiPagesAction(repo) } }));
    }
    const page = await editWikiPageFromForm(c.env, pair, doer, rawTail, form, url.origin);
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/wiki/${page.sub_url}` } }));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // The service's exact validation texts re-render the form (the family
    // convention); the wiki's own edit/new arms.
    if (action === "_new") {
      return respond(c.html(renderWikiNewPage({ ctx, initialTitle: form.title, error: error.message }), 200));
    }
    const data = await loadWikiEditData(c.env, pair, rawTail, url.origin);
    if (data.outcome !== "edit") {
      return respond(new Response(null, { status: 303, headers: { location: wikiPagesAction(repo) } }));
    }
    return respond(c.html(renderWikiEditPage({ ctx, data, error: error.message }), 200));
  }
}
/**
 * POST /{owner}/{repo}/compare/{base}...{head} (upstream
 * CompareAndPullRequestPost, routers/web/repo/pull.go:1318, over the landed
 * create route's arms): the §2.8 Origin guard, the repo→viewer order, the
 * WRITER gate (`canWriteRepo` — the landed canWriteRepository through
 * ../repo-grants.ts; a signed-in
 * non-writer 404-shells like the editor surfaces, anonymous 303s onto the
 * login round-trip; upstream admits any pulls-reader, the pages/compare.tsx
 * header documents the divergence), then the landed create arms in the API
 * route's order (head === base, no common history, equal tips, duplicate,
 * empty title) — every refusal re-renders the compare page at 200 with the
 * message and the submitted values (the login failure convention). Success
 * 303s onto the created PR's detail page (upstream JSONRedirect's
 * pullIssue.Link() target).
 */
async function compareSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  // The bare URL carries no form (nothing to compare) — the registration
  // answers it with chi's 405; a null-side tail POST is hand-crafted (404).
  if (route.family !== "compare" || route.head === null) return respond(await c.notFound());
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (repo.isArchived || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const doerRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doerRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const page = parsePageNumber(url.searchParams.get("page"));
  const data = await loadCompareData(c.env, c.env.DB, repo, { base: route.base, head: route.head, page });
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  const form = await readComparePullForm(c.req.raw);
  const result = await createPullFromForm({
    request: c,
    raw: c.req.raw,
    origin: url.origin,
    pair,
    repo,
    doer: doerRow,
    data,
    form,
  });
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLink}/pulls/${result.issue.index}` } }));
  }
  if (result.outcome === "failed") {
    // The head-ref write failed after the D1 commit — the rows are rolled
    // back, the retryable-unknown state answers the gate's plain-text 500.
    return new Response(`${result.message}\n`, {
      status: 500,
      headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  return respond(
    c.html(
      renderComparePage({
        ctx,
        data,
        form,
        error: result.message,
        canCreate: data.baseKind === "branch" && data.headKind === "branch",
        page,
      }),
      200,
    ),
  );
}

// ---------------------------------------------------------------------------
// The wave-18 commit-view family (pages/commit-view.tsx — upstream web.go
// :1739 repo.Diff, the parity survey's #1 dead-end)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/commit/{sha} (pages/commit-view.tsx): the commit
 *  header (title, identities, parents) + the diff over the landed
 *  `readCommit`/`readDiff` reads. Public anonymous like every read page;
 *  non-hex segments and unresolvable full oids 404-shell (upstream Diff's
 *  git.IsErrNotExist → ctx.NotFound arm). */
async function commitViewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "commit-view") return respond(await c.notFound()); // registration/parser drift guard
  const data = await loadCommitViewData(c.env, c.env.DB, repo, route.sha);
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderCommitViewPage({ ctx, data }), 200));
}

// ---------------------------------------------------------------------------
// The wave-29 diffpatch download family (pages/diffpatch-files.ts — the
// survey's row 4: upstream web.go:1760 repo.RawDiff + web.go:1657-1658
// DownloadPullDiff/Patch)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/commit/{sha}.{diff|patch} +
 * GET /{owner}/{repo}/pulls/{index}.{diff|patch}: the raw-text downloads.
 * Upstream serves them from the web mux (no /api/v1 op): raw diff/patch
 * text with the sniffed text/plain content type and the context middleware's
 * zero-option prod Cache-Control (the module doc cites the arms). The
 * answer is not a page — the router returns the plain Response (the
 * tree-redirect precedent); the 404 family (missing/non-pull row, wrong-sha
 * shape, unresolvable oid — the short-prefix divergence) answers the §4.5
 * shell like upstream's ctx.NotFound.
 */
async function diffpatchFileDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family === "commit-diffpatch") {
    if (route.sha === undefined) return respond(await c.notFound()); // drift guard
    const body = await loadCommitDiffPatch(c.env, repo, route.sha, route.ext);
    if (body === null) return respond(c.html(renderNotFound(ctx), 404));
    return respond(diffPatchTextResponse(body));
  }
  if (route.family === "pull-diffpatch") {
    if (route.index === undefined) return respond(await c.notFound()); // drift guard
    const body = await loadPullDiffPatch(c, repo.id, route.index, route.ext);
    if (body === null) return respond(c.html(renderNotFound(ctx), 404));
    return respond(diffPatchTextResponse(body));
  }
  return respond(await c.notFound()); // drift guard
}

// ---------------------------------------------------------------------------
// The wave-32 archive download family (pages/archive-files.ts — the survey's
// row 1: upstream web.go:1689 repo.Download over
// services/repository/archiver)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/archive/{ref}.{zip|tar.gz}: the streamed archive
 * download over the landed api/services/archive.ts builder (the API route's
 * composition). Upstream answers the octet-stream + nosniff pair, the weak
 * ETag/304 pair and the Nix immutable Link header (the module doc carries
 * the matrix); the 400 class (unknown suffix, the bundle refusal — the bare
 * `/archive` tail included) is http.Error's plain text, the 404 family
 * (empty repo, unresolvable ref) the §4.5 shell like every ui download.
 */
async function archiveFileDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo, url } = resolved;
  if (route.family !== "repo-archive") return respond(await c.notFound()); // registration/parser drift guard
  const subPaths = (c.req.queries("path") ?? []).map((p) => p.replace(/^\/+|\/+$/g, "")).filter((p) => p !== "");
  const download = await loadRepoArchive(c.env, repo, route.refExt, subPaths);
  if (download.kind === "bad-format") return respond(archiveBadFormatResponse(download.message));
  if (download.kind === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    repoArchiveResponse(download, {
      origin: url.origin,
      owner: repo.ownerNamespace,
      repo: repo.slug,
      ifNoneMatch: c.req.header("if-none-match") ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// The wave-32 commit aux-JSON family (pages/commit-contained-refs.ts — the
// survey's row 3: upstream web.go:1740 repo.LoadBranchesAndTags)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/commit/{sha}/load-branches-and-tags: the
 * ContainedLinks feed the official bundle's commit page fetches (the
 * branch/tag switcher dropdowns). Upstream answers ctx.JSON's
 * `application/json;charset=utf-8` with the middleware's zero-option prod
 * Cache-Control (the module doc cites the shape + the containment cost
 * posture); the 404 family (empty repo, wrong-shape/unresolvable sha — the
 * ServerError-500 divergence) answers the §4.5 shell.
 */
async function commitContainedRefsJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "commit-contained-refs") return respond(await c.notFound()); // drift guard
  const data = await loadCommitContainedRefs(c.env, repo, route.sha);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(containedRefsResponse(data));
}

// ---------------------------------------------------------------------------
// The wave-33 tags tails (pages/tag-list-aux.ts + pages/tags.tsx's
// applyTagDelete — the survey's top-5 #2: upstream web.go:1499 GetTagList +
// web.go:1501 DeleteTag)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/tags/list (pages/tag-list-aux.ts — upstream GetTagList,
 * web.go:1499): the `{"results":[names]}` aux JSON for every viewer who can
 * see the repo; the group's MustBeNotEmpty (web.go:1500) 404-shells empty
 * repos before the load (the aux-JSON sibling of the wave-32 commit feed).
 */
async function tagListAuxJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "tags-list-aux") return respond(await c.notFound()); // drift guard
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1500's group gate)
  return respond(tagListResponse(await loadTagListAux(c.env, repo)));
}

// ---------------------------------------------------------------------------
// The wave-39 aux fragments (pages/tree-list-aux.ts +
// pages/branches-list-aux.ts — the survey's row 5: upstream web.go:1297-1306
// repo.TreeList + web.go:1695 repo.GetBranchesList; the tree-view,
// blob_excerpt and lastcommit fragments of the same row are documented
// skips — the module docs and the wave test header carry the cites)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/tree-list/{branch|tag|commit}/* (pages/tree-list-aux.ts
 * — upstream TreeList, web.go:1297-1306): the recursive file-path array for
 * every viewer who can see the repo; the 404 family (empty repo — the
 * nil-Commit arm, unresolvable ref, failed walk) answers the §4.5 shell.
 */
async function treeListAuxJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "tree-list-aux") return respond(await c.notFound()); // drift guard
  const files = await loadTreeListAux(c.env, repo, route.refType, route.refSuffix);
  if (files === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(treeListResponse(files));
}

/**
 * GET /{owner}/{repo}/tree-view/{branch|tag|commit}/* (pages/tree-view-aux.ts
 * — upstream TreeViewNodes, web.go:1302-1306): the code-tree
 * `{fileTreeNodes, renderedIconPool}` envelope for every viewer who can see
 * the repo; the 404 family (empty repo — the nil-Commit arm, unresolvable
 * ref, missing treePath, failed walk) answers the §4.5 shell like the
 * tree-list twin. `?sub_path=` names the expansion chain (FormString at
 * treelist.go:149).
 */
async function treeViewAuxJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "tree-view-aux") return respond(await c.notFound()); // drift guard
  const envelope = await loadTreeViewNodes(c.env, repo, route.refType, route.refSuffix, c.req.query("sub_path") ?? "");
  if (envelope === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(treeViewResponse(envelope));
}

/**
 * GET /{owner}/{repo}/branches/list (pages/branches-list-aux.ts — upstream
 * GetBranchesList, web.go:1695): the `{"results":[names]}` aux JSON for every
 * viewer who can see the repo; the group's MustBeNotEmpty (web.go:1696)
 * 404-shells empty repos before the load (the wave-33 tags-list-aux twin).
 */
async function branchesListAuxJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "branches-list-aux") return respond(await c.notFound()); // drift guard
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1696's group gate)
  return respond(branchesListResponse(await loadBranchesListAux(c.env, repo)));
}

// ---------------------------------------------------------------------------
// The wave-41 releases download tail (pages/release-downloads.ts — the
// survey's top-5 #1: upstream web.go:1513 repo.GetAttachment + web.go:1514
// repo.RedirectDownload over the landed release-assets data)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/releases/attachments/{uuid} and GET
 * /{owner}/{repo}/releases/download/{vTag}/{fileName}: the release-asset
 * binary serves (not pages). Upstream's group gates (web.go:1505-1514):
 * the §2.5 prologue answers the visibility arm, `releasesReadGate` the
 * MustBeNotEmpty + reqRepoReleaseReader pair (a disabled releases unit is
 * upstream CanRead(TypeReleases) false → 404), the module doc carries the
 * ServeAttachment/RedirectDownload ledger; the 404 family answers the §4.5
 * shell like every ui download.
 */
async function releaseDownloadTail(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, viewer, repo } = resolved;
  if (route.family !== "release-attachment" && route.family !== "release-download") {
    return respond(await c.notFound()); // registration/parser drift guard
  }
  if (!(await releasesReadGate(c.env.DB, repo))) return respond(c.html(renderNotFound(ctx), 404));
  // The draft gate's write arm (attachment.go:295-311's perm.CanWrite
  // (TypeReleases) — the same grant the releases pages render controls by).
  const canWriteReleases = await canWriteRepo(c.env, repo, viewer);
  let serve: ReleaseAttachmentServe;
  if (route.family === "release-download") {
    if (route.vTag === undefined || route.fileName === undefined) return respond(await c.notFound()); // drift guard
    serve = await loadReleaseDownload(c.env.REPO_PACKS, c.env.DB, repo, route.vTag, route.fileName, { canWriteReleases });
  } else {
    if (route.uuid === undefined) return respond(await c.notFound()); // drift guard
    serve = await openReleaseAttachment(c.env.REPO_PACKS, c.env.DB, repo, route.uuid, { canWriteReleases });
  }
  if (serve.kind === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    releaseAttachmentResponse(serve, {
      ifNoneMatch: c.req.header("if-none-match") ?? null,
      ifModifiedSince: c.req.header("if-modified-since") ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// The wave-41 rendered blob views (pages/render-files.ts — the survey's
// row 3: upstream web.go:1715-1719's /render group over repo.RenderFile)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/render/{branch|tag|commit}/* and
 * GET /{owner}/{repo}/render/blob/{sha}: the standalone-page renders the
 * official bundle's external-render iframe fetches. The group's gates
 * (web.go:1653-1762's closing args + the subgroup's MustBeNotEmpty): the §2.5
 * prologue + the empty-repo 404 (the module doc carries the pipeline mapping
 * and the 400/404 family ledger).
 */
async function renderFileView(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo, url } = resolved;
  if (route.family !== "render-file") return respond(await c.notFound()); // drift guard
  let target: RenderFileTarget;
  if (route.sha !== undefined) target = { kind: "blob", sha: route.sha };
  else if (route.refType !== undefined && route.refSuffix !== undefined) {
    target = { kind: "ref", refType: route.refType, refSuffix: route.refSuffix };
  } else return respond(await c.notFound()); // drift guard
  const load = await loadRenderFile(c.env, repo, target, url.origin);
  if (load.kind === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  if (load.kind === "no-renderer") return respond(renderNotAvailableResponse());
  return respond(renderFileResponse(load.html));
}

// ---------------------------------------------------------------------------
// The wave-46 fragment mounts (the machinery waves' routes — the survey
// row-5 skips landing: pages/repo-lastcommit-fragment.tsx's route handoff +
// pages/repo-blob-excerpt-fragment.tsx's stage 3)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/lastcommit/* (pages/repo-lastcommit-fragment.tsx —
 * upstream web.go:1761's `RepoRefByType(RefTypeCommit)` + repo.LastCommit,
 * view.go:233-250): the directory-listing commit-info refresh the
 * `#repo-files-table` loader fetches. The handoff's arms, in order: the
 * §2.5 prologue (the code-read group's posture — the visibility resolution
 * covers reqUnitCodeReader, the render-file precedent); the tail parse
 * (parseLastCommitTail — the pattern miss 404-shells, upstream's
 * getRefNameFromPath ""); the loader's null family (the empty repo, an
 * unresolvable sha, a missing treePath — upstream's NotFound/ServerError
 * pair, both 404 here); then the standalone fragment Response with repoLink
 * `/${repo.ownerNamespace}/${repo.slug}`.
 */
async function lastCommitFragment(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "lastcommit") return respond(await c.notFound()); // registration/parser drift guard
  const tail = parseLastCommitTail(route.rawTail);
  if (tail === null) return respond(c.html(renderNotFound(ctx), 404)); // the route pattern's miss
  const data = await loadLastCommitFragment(c.env, repo, tail.commitRef, tail.treePath, c.req.query("refSubUrl") ?? "");
  if (data === null) return respond(c.html(renderNotFound(ctx), 404)); // the empty-repo/sha/treePath family
  return respond(lastCommitFragmentResponse(lastCommitFragmentHtml(data, `/${repo.ownerNamespace}/${repo.slug}`)));
}

/**
 * GET /{owner}/{repo}/blob_excerpt/{sha} and
 * GET /{owner}/{repo}/wiki/blob_excerpt/{sha} (pages/repo-blob-excerpt-
 * fragment.tsx — upstream web.go:1735 + web.go:1618's repo.ExcerptBlob,
 * compare.go:706-795): the hunk-window expansion rows the diff view's
 * expander buttons morph in. The group gates: the §2.5 prologue covers the
 * code-read (web.go:1653-1762's closing args) and the wiki twin's
 * reqUnitWikiReader; the wiki twin's MustEnableWiki (web.go:1614) reads the
 * landed repo-settings `hasWiki` (the wave-45 hasProjects precedent) — a
 * disabled wiki 404-shells. The rest rides the loader (the module doc
 * carries the knob-by-knob mapping and the 404 family): form parse → the
 * excerpt section → FileNameHash → the unified-arm fragment Response.
 */
async function blobExcerptFragment(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "blob-excerpt" && route.family !== "wiki-blob-excerpt") {
    return respond(await c.notFound()); // registration/parser drift guard
  }
  const wiki = route.family === "wiki-blob-excerpt";
  if (wiki) {
    const settings = await loadRepoSettings(c.env.DB, repo.id);
    if (!settings.hasWiki) return respond(c.html(renderNotFound(ctx), 404)); // MustEnableWiki (web.go:1614)
  }
  const form = parseBlobExcerptForm(resolved.url.searchParams);
  const load = await loadBlobExcerptSection(c.env, repo, route.sha, wiki, form);
  if (load === null) return respond(c.html(renderNotFound(ctx), 404)); // the empty/sha/path 404 family
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const html = blobExcerptFragmentHtml({
    section: load.section,
    fileNameHash: await hashFilePathForWebUI(load.filePath), // compare.go:792's FileNameHash
    baseLink: `${repoLink}${wiki ? "/wiki" : ""}/blob_excerpt`, // compare.go:719/729's BaseLink
    afterCommitID: route.sha, // compare.go:718's AfterCommitID — the path param verbatim
    style: form.style, // GetDiffViewStyle's resolved echo (middlewares.go:35-37)
  });
  return respond(blobExcerptFragmentResponse(html));
}

/** The wave-33 tag delete's refusal shape — ctx.HTTPError(409, …)'s
 *  plain-text form (release.go:677-680 → base.go:105-113, the archive
 *  family's established answer), stamped with the web middleware's
 *  zero-option prod Cache-Control. */
function tagDeleteConflictResponse(): Response {
  return new Response(`${TAG_RELEASE_ATTACHED_MESSAGE}\n`, {
    status: 409,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}

/**
 * POST /{owner}/{repo}/tags/delete (pages/tags.tsx applyTagDelete — upstream
 * repo.DeleteTag → deleteReleaseOrTag(isDelTag=true), web.go:1501): the §2.8
 * Origin guard, the tags group's gates in upstream's order (MustBeNotEmpty →
 * RepoMustNotBeArchived → reqRepoCodeWriter; anonymous first — reqSignIn
 * precedes the group's optSignIn posture), then the write over the dual
 * carriers (the `id` D1-record key, the `tag` name arm for the rowless
 * engine tags — the TagRowView note). Every refusal answers upstream's
 * class: the release-attached 409 plain text, the missing id/tag the 404
 * shell; the flash outcomes 303 back onto the list with the branches
 * page's query-param convention (protected → tag_name_protected, failed →
 * the server-side text).
 */
async function tagsDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (resolved.route.family !== "tags-delete") return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname)); // reqSignIn
  if (repo.isEmpty || repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty + RepoMustNotBeArchived
  if (!(await canWriteRepo(c.env, repo, viewer))) return respond(c.html(renderNotFound(ctx), 404)); // reqRepoCodeWriter
  const subject = parseTagDeleteForm(await readUrlEncodedForm(c.req.raw));
  const doerRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doerRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined; // in-process test callers have no execution context
  }
  const result = await applyTagDelete(c.env, c.env.DB, repo, subject, {
    pair,
    doer: doerRow,
    origin: url.origin,
    waitUntil,
  });
  if (result.outcome === "release-attached") return respond(tagDeleteConflictResponse());
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const listPath = `/${repo.ownerNamespace}/${repo.slug}/tags`;
  const location =
    result.outcome === "deleted"
      ? `${listPath}?deleted=${encodeURIComponent(result.name)}`
      : `${listPath}?delete_error=${result.outcome === "refused-protected" ? "protected" : "failed"}&name=${encodeURIComponent(result.name)}`;
  return respond(new Response(null, { status: 303, headers: { location } }));
}

// ---------------------------------------------------------------------------
// The wave-33 releases edit/delete tails (pages/releases.tsx — the survey's
// top-5 #4: upstream web.go:1519-1520 EditRelease/EditReleasePost +
// web.go:1523 DeleteRelease under the write group)
// ---------------------------------------------------------------------------

/** The edit form's fixed meta (the stored row's tag pair + delete id) and
 *  prefill (release.go:579-590 — the stored values, tag_target's
 *  default-branch fallback). */
function editReleaseMetaOf(repo: RepoRow, row: { tagName: string; target: string | null; id: number }): {
  tagName: string;
  target: string;
  deleteId: number;
} {
  const storedTarget = row.target ?? "";
  return { tagName: row.tagName, target: storedTarget === "" ? repo.defaultBranch : storedTarget, deleteId: row.id };
}

/**
 * GET /{owner}/{repo}/releases/edit/{tag} (pages/releases.tsx — upstream
 * repo.EditRelease, web.go:1519): the writer-gated form (the write group's
 * releasesWriteGate), the stored values prefilled, the 404 arms first (a
 * missing row, a TAG-ONLY record — release.go:573-576's "pure tag" arm).
 */
async function releaseEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await releasesWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, respond, repo } = resolved;
  const route = resolved.route;
  if (route.family !== "release-edit" || route.tag === undefined) return respond(await c.notFound()); // drift guard
  const row = await loadEditReleaseData(c.env.DB, repo.id, route.tag);
  if (row === null) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadNewReleaseData(c.env, repo);
  return respond(
    c.html(
      renderEditReleasePage({
        ctx,
        data,
        form: {
          tagName: row.tagName,
          tagTarget: row.target ?? "",
          title: row.title,
          content: row.note ?? "",
          draft: row.isDraft,
          prerelease: row.isPrerelease,
        },
        error: null,
        edit: editReleaseMetaOf(repo, row),
      }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/releases/edit/{tag} (upstream EditReleasePost,
 * web.go:1520): the §2.8 Origin guard, the write gate, the row resolved by
 * the URL's tag (the PathParam the form's hidden pair never overrides), then
 * editReleaseFromForm — success 303s onto the LIST (upstream JSONRedirect's
 * exact target), the failures re-render at 200 with the message and the
 * kept submission (the login failure convention).
 */
async function releaseEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await releasesWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, viewer, respond, repo } = resolved;
  const route = resolved.route;
  if (route.family !== "release-edit" || route.tag === undefined) return respond(await c.notFound()); // drift guard
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const row = await loadEditReleaseData(c.env.DB, repo.id, route.tag);
  if (row === null) return respond(c.html(renderNotFound(ctx), 404));
  const doerRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doerRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseEditReleaseForm(await readUrlEncodedForm(c.req.raw));
  const result = await editReleaseFromForm({
    env: c.env,
    request: c,
    repo,
    pair,
    doer: doerRow,
    row,
    form,
    origin: url.origin,
  });
  if (result.outcome === "updated") {
    return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/releases` } }));
  }
  const data = await loadNewReleaseData(c.env, repo);
  return respond(
    c.html(
      renderEditReleasePage({
        ctx,
        data,
        form: { tagName: row.tagName, tagTarget: row.target ?? "", ...form },
        error: result.message,
        edit: editReleaseMetaOf(repo, row),
      }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/releases/delete (upstream DeleteRelease,
 * web.go:1523): the write gate, then deleteReleaseFromForm over the form's
 * `id` (the edit page's red button carrier) — success 303s onto the list
 * with the ?deleted= flash (upstream JSONRedirect + deletion_success's
 * flash), a missing id 404-shells (upstream NotFound).
 */
async function releaseDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await releasesWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (resolved.route.family !== "release-delete") return respond(await c.notFound()); // drift guard
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const id = parseReleaseDeleteForm(await readUrlEncodedForm(c.req.raw));
  if (id === null) return respond(c.html(renderNotFound(ctx), 404));
  const doerRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doerRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const result = await deleteReleaseFromForm({
    env: c.env,
    request: c,
    repo,
    pair,
    doer: doerRow,
    id,
    origin: url.origin,
  });
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    new Response(null, {
      status: 303,
      headers: { location: `/${repo.ownerNamespace}/${repo.slug}/releases?deleted=${encodeURIComponent(result.name)}` },
    }),
  );
}

// ---------------------------------------------------------------------------
// The wave-20 releases family (pages/releases.tsx — upstream's web.go:1505-
// 1527 group at the landed api/services/releases.ts + release-assets.ts
// reads and the SPEC-0005 create arm)
// ---------------------------------------------------------------------------

/**
 * The releases family's read gate (upstream's group middleware verbatim):
 * `repo.MustBeNotEmpty` — an empty repo 404-shells the whole family — and
 * the releases unit gate (the API family's `mustEnableUnit` posture, the
 * routes' runtime 412; a page answers the invisible §4.5 shell).
 */
async function releasesReadGate(db: D1Database, repo: RepoRow): Promise<boolean> {
  if (repo.isEmpty) return false;
  return (await loadRepoSettings(db, repo.id)).hasReleases;
}

/** The form routes' gate (upstream's write group): the read gate plus
 *  `context.RepoMustNotBeArchived()` — archived repos 404-shell (the
 *  file-editor reduction of upstream's 403) — and the release-write grant
 *  (`reqRepoReleaseWriter` → canWriteRepo; anonymous already went to the
 *  login 303 before this check). */
async function releasesWriteGate(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
): Promise<Response | null> {
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (repo.isArchived || !(await releasesReadGate(c.env.DB, repo))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  if (!(await canWriteRepo(c.env, repo, viewer))) return respond(c.html(renderNotFound(ctx), 404));
  return null;
}

/** GET /{owner}/{repo}/releases (pages/releases.tsx — upstream repo.Releases,
 *  web.go:1506): the list for every viewer who can see the repo; drafts ride
 *  the write grant (upstream IncludeDrafts: writeAccess) and the New Release
 *  button the create grant (`CanCreateRelease` = write && !archived). */
async function releasesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (!(await releasesReadGate(c.env.DB, repo))) return respond(c.html(renderNotFound(ctx), 404));
  const canWrite = await canWriteRepo(c.env, repo, viewer);
  const data = await loadReleasesData(c.env, c.env.DB, repo, canWrite, url.searchParams, url.origin);
  data.canCreate = canWrite;
  // The wave-33 delete write's flash params (the tags page's wave-33
  // convention — the POST 303s back with ?deleted=; display-only).
  return respond(
    c.html(
      renderReleasesPage(ctx, data, {
        deleted: url.searchParams.get("deleted"),
        errorKind: url.searchParams.get("delete_error"),
        errorName: url.searchParams.get("name") ?? "",
      }),
      200,
    ),
  );
}

/** GET /{owner}/{repo}/releases/new (pages/releases.tsx — upstream
 *  repo.NewRelease, web.go:1517): the writer-gated create form. The `?tag=`
 *  query prefills the tag-name field (wave 25 — the tags page's per-row
 *  "New Release" links carry it, upstream tags list.tmpl's exact shape). */
async function releaseNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await releasesWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, respond, repo } = resolved;
  const data = await loadNewReleaseData(c.env, repo);
  return respond(
    c.html(
      renderNewReleasePage({
        ctx,
        data,
        form: {
          tagName: (url.searchParams.get("tag") ?? "").trim().slice(0, 255),
          tagTarget: "",
          title: "",
          content: "",
          draft: false,
          prerelease: false,
        },
        error: null,
      }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/releases/new (upstream NewReleasePost, web.go:1518):
 * the §2.8 Origin guard, then the same gate order as the GET, then the
 * landed create arm through createReleaseFromForm (pages/releases.tsx — the
 * API POST route's service call + webhook sequence). Success 303s onto the
 * created release's DETAIL page (the task brief, the new-issue POST
 * convention — upstream JSONRedirects onto the list, the module header's
 * note); validation failures re-render the form at 200 with the message and
 * the kept submission (the login failure convention).
 */
async function releaseNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await releasesWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const form = parseNewReleaseForm(await readUrlEncodedForm(c.req.raw));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const doer = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doer === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const data = await loadNewReleaseData(c.env, repo);
  const result = await createReleaseFromForm({
    env: c.env,
    request: c,
    repo,
    pair,
    doer,
    form,
    branches: data.branches,
    origin: url.origin,
  });
  if (result.outcome === "created") {
    return respond(
      new Response(null, {
        status: 303,
        headers: {
          location: `/${repo.ownerNamespace}/${repo.slug}/releases/tag/${pathEscapeSegments(result.tag)}`,
        },
      }),
    );
  }
  return respond(c.html(renderNewReleasePage({ ctx, data, form, error: result.message }), 200));
}

/**
 * GET /{owner}/{repo}/releases/latest (upstream repo.LatestRelease,
 * web.go:1510): 303 onto the latest stable release's detail page
 * (`ctx.Redirect(release.Link())` — the html_url shape); no stable release
 * 404-shells (upstream NotFound).
 */
async function releaseLatestRedirect(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond, repo } = resolved;
  if (!(await releasesReadGate(c.env.DB, repo))) return respond(c.html(renderNotFound(ctx), 404));
  const tag = await latestReleaseTagOf(c.env.DB, repo.id);
  if (tag === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    new Response(null, {
      status: 303,
      headers: { location: `/${repo.ownerNamespace}/${repo.slug}/releases/tag/${pathEscapeSegments(tag)}` },
    }),
  );
}

/**
 * GET /{owner}/{repo}/releases/tag/{tag} (upstream repo.SingleRelease,
 * web.go:1509): ONE release rendered through the same list entry — the
 * landed read's exact visibility rules (tag-only records and foreign-eye
 * drafts 404); the header menu shows the write-aware repo total (the
 * `NumReleases` the shared template renders).
 */
async function releaseDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (!(await releasesReadGate(c.env.DB, repo))) return respond(c.html(renderNotFound(ctx), 404));
  const route = resolved.route;
  if (route.family !== "release-detail" || route.tag === undefined) return respond(await c.notFound()); // drift guard
  const canWrite = await canWriteRepo(c.env, repo, viewer);
  const entry = await loadReleaseDetailData(c.env, c.env.DB, repo, route.tag, canWrite, url.origin);
  if (entry === null) return respond(c.html(renderNotFound(ctx), 404));
  const { total } = await listReleases(c.env.DB, repo.id, {
    includeDrafts: canWrite,
    isDraft: null,
    isPrerelease: null,
    tagFilter: "",
    page: 1,
    limit: 1,
  });
  return respond(c.html(renderReleaseDetailPage({ ctx, entry, total }), 200));
}

/**
 * One handler for every claimed GET page family: the parser re-reads the
 * pathname (the route registrations below exist so the sub-app never claims
 * beyond the parser's families), the repo resolves through the §2.5
 * public-repo read, and the page switch renders (render.tsx delegates per
 * family). All routes are GET-only (§2.1); every unresolved repo/ref/path
 * answers the §4.5 404 shell, and a missing/unreadable manifest answers the
 * §2.3.4 503 before any page work happens.
 */
async function uiPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, route, ctx, viewer, respond, repo } = resolved;

  // Wave-2 dispatch (render.tsx never sees these families). The redirect
  // and the list page run AFTER the same §2.5 repo resolution as the
  // slice-1 pages: unknown/private repos 404-shell, never redirect. Wave 41
  // adds ctx.Redirect's fetch-action arm to BOTH siblings (base.go:153-156 —
  // a non-empty X-Gitea-Fetch-Action header answers 200 {"redirect": …}
  // instead of the 303).
  if (route.family === "tree") {
    // Bare /tree has no upstream route (chi needs the slash) → §4.5 shell.
    if (route.rawSuffix === "") return respond(c.html(renderNotFound(ctx), 404));
    // The target prefix is the RESOLVED row's canonical link (upstream
    // ctx.Repo.RepoLink); the suffix and query travel verbatim.
    const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
    return respond(treeRedirectResponse(repoLink, route.rawSuffix, url.search, isFetchActionRequest(c.req.raw)));
  }
  // Wave-39: the blob-redirect twin (upstream RedirectRepoBlobToCommit —
  // the redirect runs AFTER the repository resolves exactly like the tree
  // family: unknown/private repos 404-shell, never redirect; the bare
  // /blob has no upstream route → §4.5 shell; the wave-41 fetch-action arm
  // rides the same header check).
  if (route.family === "blob-redirect") {
    if (route.rawSuffix === "") return respond(c.html(renderNotFound(ctx), 404));
    const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
    return respond(blobRedirectResponse(repoLink, route.rawSuffix, url.search, isFetchActionRequest(c.req.raw)));
  }
  if (route.family === "issues" || route.family === "pulls") {
    const data = await loadIssuesListData(c.env.DB, repo.id, route.family, url.searchParams);
    return respond(c.html(renderIssuesListPage(ctx, data), 200));
  }
  // Wave-3 dispatch: the issue/PR detail page (render.tsx never sees this
  // family). Upstream's type/URL match runs after the row lookup
  // (issue_view.go:347-352) — a mismatched family 303s onto Issue.Link(),
  // an unknown index 404-shells with the repo context (§4.5).
  if (route.family === "issue-detail") {
    const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
    const data = await loadIssueDetailData(c.env.DB, repo, route.urlKind, route.index, url.origin, viewer);
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    const redirect = crossFamilyRedirect(route.urlKind, repoLink, data.issue.index, data.issue.isPull);
    if (redirect !== null) return respond(new Response(null, { status: 303, headers: { location: redirect } }));
    // Wave-5: the signed-in chrome (status button + admin label form) needs
    // the viewer's grants; anonymous resolves to the all-false access.
    const access = await resolveIssueDetailAccess(c.env, repo, resolved.viewer, data.issue);
    return respond(c.html(renderIssueDetailPage(ctx, data, access), 200));
  }
  // Wave-5 dispatch: the PR files diff view (render.tsx never sees this
  // family; non-pull rows 404-shell — pull-files.tsx header).
  if (route.family === "pull-files") {
    const data = await loadPullFilesData(c, repo.id, route.index);
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    return respond(c.html(renderPullFilesPage({ ctx, data }), 200));
  }
  // The PR commits tab (render.tsx never sees this family; non-pull rows and
  // unresolvable base/head refs 404-shell — pull-commits.tsx header, the
  // upstream ViewPullCommits NotFound arm).
  if (route.family === "pull-commits") {
    const data = await loadPullCommitsData(c.env, repo, route.index, url.searchParams.get("page"));
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    return respond(c.html(renderPullCommitsPage({ ctx, data }), 200));
  }
  // Wave-18 dispatch: the commit view (render.tsx never sees this family;
  // non-hex segments and unresolvable full oids 404-shell — the page
  // module's sha arms).
  if (route.family === "commit-view") {
    const data = await loadCommitViewData(c.env, c.env.DB, repo, route.sha);
    if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
    return respond(c.html(renderCommitViewPage({ ctx, data }), 200));
  }
  // Wave-24 dispatch: the repo social lists (render.tsx never sees these
  // families; the loader's family switch picks the landed read — forks
  // through the viewer's reduced accessible-condition, stars/watchers
  // through the social lists).
  if (route.family === "forks" || route.family === "stars" || route.family === "watchers") {
    const data = await loadRepoSocialData(c.env.DB, repo, viewer, route.family, url.searchParams);
    return respond(c.html(renderRepoSocialPage(ctx, data), 200));
  }
  // Wave-25 dispatch: the tags listing (render.tsx never sees this family;
  // the engine ref universe read — the group's MustBeNotEmpty gate answers
  // the 404 shell for empty repos before the load).
  if (route.family === "tags") {
    if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1497's group gate)
    const page = parsePageNumber(url.searchParams.get("page"));
    const keyword = (url.searchParams.get("q") ?? "").slice(0, 255);
    const data = await loadTagsData(c.env, c.env.DB, repo, { page, keyword, viewer });
    // The wave-33 delete write's flash params (the branches page's
    // query-param convention — the POST 303s back with ?deleted=/
    // ?delete_error=; display-only).
    return respond(
      c.html(
        renderTagsPage({
          ctx,
          data,
          flash: {
            deleted: url.searchParams.get("deleted"),
            errorKind: url.searchParams.get("delete_error"),
            errorName: url.searchParams.get("name") ?? "",
          },
        }),
        200,
      ),
    );
  }

  // U3 page switch (render.tsx — home | commits | src), with the 404 shell
  // for unresolvable refs/paths (§4.5).
  if (!isSliceOneRoute(route)) return respond(await c.notFound()); // registration/parser drift guard
  const { status, html } = await renderUiPage({ env: c.env, ctx, route, url });
  return respond(c.html(html, status));
}

// ---------------------------------------------------------------------------
// The wave-23 org families (pages/org-members.tsx + pages/org-repos.tsx —
// upstream's /org/{org}/members literal web.go:965 and the
// /{username}/-/repositories route web.go:1134)
// ---------------------------------------------------------------------------

/** The org-family doer slice (the org-teams prologue's construction). */
function orgFamilyDoer(viewer: Viewer): { id: number | null; isAdmin: boolean } {
  return viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
}

/** The org-family query string (resolveOrgForRequest's rename-redirect
 *  rewrite consumes it — the org-teams prologue's slice). */
function orgFamilyQuery(url: URL): string {
  return url.search.startsWith("?") ? url.search.slice(1) : url.search;
}

/**
 * GET /org/{org}/members (pages/org-members.tsx — the members list).
 * Anonymous-capable (upstream's group gate is RequireSignInViewStrict, off
 * at the pin): the org resolves through the org-home ladder (a plain user
 * name and an invisible org 404-shell, a rename 307s), the members
 * listing's PublicOnly scope is the per-row gate, and the owner prompt row
 * rides OrgAssignment's IsOwner composition (isOrgOwnerViewer).
 */
async function orgMembersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (resolved.route.family !== "org-members") return respond(await c.notFound()); // drift guard
  const doer = orgFamilyDoer(viewer);
  const org = await resolveOrgMembersOrg(c.env.DB, resolved.route.owner, doer, url.pathname, orgFamilyQuery(url));
  if (org.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: org.location } }));
  }
  if (org.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const ownerPrompt = await isOrgOwnerViewer(c.env.DB, org.org, viewer);
  const data = await loadOrgMembersData(c.env.DB, org.org, doer, url.searchParams);
  return respond(c.html(renderOrgMembersPage(ctx, data, { ownerPrompt }), 200));
}

/**
 * GET /{org}/-/repositories (pages/org-repos.tsx — the repositories family;
 * the org-home DOM through upstream's second URL). The same ladder: a plain
 * user name 404-shells (upstream org.Repositories' `org == nil` arm), a
 * renamed org 307s, an invisible org shells behind the shared 404. The
 * listing itself is the landed `listOrgRepositories` read (the §4.7
 * owner/team visibility arms decide the rows).
 */
async function orgRepositoriesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (resolved.route.family !== "org-repositories") return respond(await c.notFound()); // drift guard
  const doer = orgFamilyDoer(viewer);
  const org = await resolveOrgRepositories(c.env.DB, resolved.route.owner, doer, url.pathname, orgFamilyQuery(url));
  if (org.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: org.location } }));
  }
  if (org.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadOrgRepositoriesData(c.env.DB, org.org, doer, url.searchParams);
  return respond(c.html(renderOrgRepositoriesPage(ctx, data), 200));
}

/**
 * GET /{owner}/-/projects (pages/owner-projects.tsx — the wave-37 projects
 * list; upstream's web.go:1143 read group over BOTH owner kinds). The
 * ladder: the org half (renamed orgs 307, invisible orgs 404-shell) gated
 * by orgProjectsAccessMode >= read (web.go:444-455), then the user half
 * (renamed users 307) gated by the individualPermsChecker ladder
 * (web.go:945-959 — private users answer to self or site admin only).
 * The listing rides the landed projects service — the doer-visibility-
 * filtered issue counts are the page's matrix.
 */
async function ownerProjectsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (resolved.route.family !== "owner-projects") return respond(await c.notFound()); // drift guard
  const doer = orgFamilyDoer(viewer);
  const owner = await resolveOwnerProjects(c.env.DB, resolved.route.owner, doer, url.pathname, orgFamilyQuery(url));
  if (owner.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: owner.location } }));
  }
  if (owner.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadOwnerProjectsData(c.env.DB, owner, viewer, url.origin, url.searchParams);
  return respond(c.html(renderOwnerProjectsPage(ctx, data), 200));
}

// ---------------------------------------------------------------------------
// The wave-40 owner projects BOARD families (pages/owner-project-board.tsx —
// upstream's web.go:1140-1155 board view + write group + the web.go:327-345
// board/workflow helper POSTs). Every handler rides the LIST page's
// resolution (the read group gates), then the write group's ladder at the
// shared depth prologue + ownerProjectWriteGate.
// ---------------------------------------------------------------------------

/** The wave-40 families' guard — the depth prologue accepts exactly these
 *  (all carrying the board id). */
function isOwnerProjectBoardRoute(route: ParsedUiRoute): route is OwnerProjectBoardRoute {
  return (
    route.family === "owner-project-board" ||
    route.family === "owner-project-edit" ||
    route.family === "owner-project-delete" ||
    route.family === "owner-project-status" ||
    route.family === "owner-project-column-new" ||
    route.family === "owner-project-column-default" ||
    route.family === "owner-project-workflows" ||
    route.family === "owner-project-workflow-delete"
  );
}

/** The resolved projects depth: the read-gated owner + the owner-scoped
 *  project row + the parsed route (the `/-/projects/{id}` families only —
 *  `/new` resolves its owner inline). */
type ResolvedProjectDepth =
  | {
      ok: true;
      url: URL;
      ctx: UiContext;
      viewer: Viewer;
      respond: (res: Response) => Response;
      route: OwnerProjectBoardRoute;
      owner: ResolvedOwner;
      /** The owner's `/-/projects` list base (the list-landing 303 target). */
      ownerLink: string;
      project: ProjectRow;
    }
  | { ok: false; response: Response };

/** The owner's namespace segment (the list base's head). */
function ownerBase(owner: ResolvedOwner): string {
  return owner.kind === "org" ? owner.org.username : owner.user.username;
}

/**
 * The projects depth's shared prologue: the LIST page's resolution (the read
 * group — the org unit-access gate or the individualPermsChecker ladder, the
 * rename-307 seam included), then the owner-scoped project read
 * (GetProjectByIDAndOwner — another owner's id reads as not found). A
 * missing owner or project 404-shells.
 */
async function resolveOwnerProjectDepth(c: Context<{ Bindings: Env }>): Promise<ResolvedProjectDepth> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved;
  const { url, ctx, viewer, respond, route } = resolved;
  if (!isOwnerProjectBoardRoute(route)) return { ok: false, response: await c.notFound() }; // drift guard
  const owner = await resolveOwnerProjects(c.env.DB, route.owner, boardDoer(viewer), url.pathname, orgFamilyQuery(url));
  if (owner.kind === "redirect") {
    return {
      ok: false,
      response: respond(new Response(null, { status: 307, headers: { location: owner.location } })),
    };
  }
  if (owner.kind === "missing") return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  const project = await findOwnerProject(c.env.DB, owner, route.id ?? 0);
  if (project === null) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  return {
    ok: true,
    url,
    ctx,
    viewer,
    respond,
    route,
    owner,
    ownerLink: `/${ownerBase(owner)}/-/projects`,
    project,
  };
}

/**
 * The write group's gate (web.go:1146-1155, mounted inside the read group):
 * anonymous → the login 303 (reqSignIn), a signed-in non-writer → the 404
 * shell (reqAnyRepoUnitAccess(write, true) + the web.go:1151-1155 individual
 * check — canWriteProjects covers both, INCLUDING the site-admin-on-another-
 * user's-project arm). Returns the Response to answer, or null to proceed.
 */
function ownerProjectWriteGate(
  c: Context<{ Bindings: Env }>,
  depth: Extract<ResolvedProjectDepth, { ok: true }>,
): Promise<Response | null> {
  return ownerProjectWriteGateAt(c, depth.owner, depth.viewer, depth.ctx, depth.respond, depth.url.pathname);
}

/** The write gate's free-variable form (the /new handlers' inline owner). */
async function ownerProjectWriteGateAt(
  c: Context<{ Bindings: Env }>,
  owner: ResolvedOwner,
  viewer: Viewer,
  ctx: UiContext,
  respond: (res: Response) => Response,
  pathname: string,
): Promise<Response | null> {
  if (viewer.kind === "anonymous") return respond(loginRedirect(pathname));
  if (!(await ownerProjectWriteAccess(c.env.DB, owner, boardDoer(viewer)))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  return null;
}

/** GET /{owner}/-/projects/{id} (org.ViewProject — the board). */
async function ownerProjectBoardPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, respond, owner, project } = depth;
  const data = await loadProjectBoardData(c.env.DB, owner, project, viewer, url.origin, url.searchParams);
  return respond(c.html(renderProjectBoardPage({ ctx, data, columnForm: { title: "", color: "" }, columnError: null }), 200));
}

/** The /new handlers' shared prologue (no board id — the owner resolves
 *  inline through the LIST page's seam). */
type ResolvedOwnerEntry =
  | (Extract<Awaited<ReturnType<typeof resolveUiSession>>, { ok: true }> & { owner: ResolvedOwner })
  | { ok: false; response: Response };

async function resolveOwnerEntry(c: Context<{ Bindings: Env }>): Promise<ResolvedOwnerEntry> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved;
  const { url, viewer, respond } = resolved;
  if (resolved.route.family !== "owner-project-new") return { ok: false, response: await c.notFound() }; // drift guard
  const owner = await resolveOwnerProjects(c.env.DB, resolved.route.owner, boardDoer(viewer), url.pathname, orgFamilyQuery(url));
  if (owner.kind === "redirect") {
    return { ok: false, response: respond(new Response(null, { status: 307, headers: { location: owner.location } })) };
  }
  if (owner.kind === "missing") return { ok: false, response: respond(c.html(renderNotFound(resolved.ctx), 404)) };
  return { ...resolved, owner };
}

/** GET /{owner}/-/projects/new (RenderNewProject — the write group's form;
 *  the write gate is the route group's, run before any render). */
async function ownerProjectNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const entry = await resolveOwnerEntry(c);
  if (!entry.ok) return entry.response;
  const { ctx, viewer, respond, owner } = entry;
  const gate = await ownerProjectWriteGateAt(c, owner, viewer, ctx, respond, new URL(c.req.url).pathname);
  if (gate !== null) return gate;
  const counts = await loadProjectChromeCounts(c.env.DB, owner, viewer);
  return respond(
    c.html(
      renderNewProjectPage({ ctx, owner, form: { title: "", content: "", templateType: "", cardType: "" }, error: null, counts }),
      200,
    ),
  );
}

/** POST /{owner}/-/projects/new (NewProjectPost): success 303s onto the
 *  LIST page, the binding failures re-render at 200 with the message and
 *  the kept submission. */
async function ownerProjectNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const entry = await resolveOwnerEntry(c);
  if (!entry.ok) return entry.response;
  const { ctx, viewer, respond, owner } = entry;
  const gate = await ownerProjectWriteGateAt(c, owner, viewer, ctx, respond, new URL(c.req.url).pathname);
  if (gate !== null) return gate;
  const doer = boardDoer(viewer);
  if (doer.id === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseProjectForm(await readUrlEncodedForm(c.req.raw));
  const result = await createProjectFromForm(c.env.DB, owner, doer.id, form, new Date());
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `/${ownerBase(owner)}/-/projects` } }));
  }
  const counts = await loadProjectChromeCounts(c.env.DB, owner, viewer);
  return respond(c.html(renderNewProjectPage({ ctx, owner, form, error: result.message, counts }), 200));
}

/** GET /{owner}/-/projects/{id}/edit (RenderEditProject — the pre-filled
 *  form; `?redirect=project` rides the hidden field to the POST). */
async function ownerProjectEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, respond, owner, project } = depth;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  const data = await loadProjectBoardData(c.env.DB, owner, project, viewer, url.origin, new URLSearchParams());
  return respond(
    c.html(
      renderEditProjectPage({
        ctx,
        data,
        form: {
          title: project.title,
          content: project.description,
          templateType: "",
          cardType: cardTypeToString(project.cardType),
        },
        error: null,
        redirect: url.searchParams.get("redirect") ?? "",
      }),
      200,
    ),
  );
}

/** POST /{owner}/-/projects/{id}/edit (EditProjectPost): success 303s onto
 *  the board when the form's hidden `redirect=project` rode (upstream's
 *  ctx.Redirect(p.Link())), else onto the LIST page; the binding failures
 *  re-render at 200. */
async function ownerProjectEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, respond, owner, project } = depth;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  const formParams = await readUrlEncodedForm(c.req.raw);
  const form = parseProjectForm(formParams);
  const result = await updateProjectFromForm(c.env.DB, project, form, new Date());
  if (result.outcome === "updated") {
    const target =
      formParams.get("redirect") === "project" ? projectLinkOf(owner, project) : `/${ownerBase(owner)}/-/projects`;
    return respond(new Response(null, { status: 303, headers: { location: target } }));
  }
  const data = await loadProjectBoardData(c.env.DB, owner, project, viewer, url.origin, new URLSearchParams());
  return respond(
    c.html(
      renderEditProjectPage({
        ctx,
        data,
        form,
        error: result.message,
        redirect: formParams.get("redirect") ?? "",
      }),
      200,
    ),
  );
}

/** POST /{owner}/-/projects/{id}/delete (DeleteProject): the cascade delete
 *  then the 303 onto the LIST page (upstream's JSONRedirect target). */
async function ownerProjectDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  await deleteProjectById(c.env.DB, depth.project.id);
  return depth.respond(new Response(null, { status: 303, headers: { location: `/${ownerBase(depth.owner)}/-/projects` } }));
}

/** POST /{owner}/-/projects/{id}/open|close (ChangeProjectStatus): the
 *  guarded flip then the 303 onto the board (upstream's JSONRedirect →
 *  ProjectLinkForOrg). */
async function ownerProjectStatusSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  const action = depth.route.family === "owner-project-status" ? depth.route.action : undefined;
  if (action !== "open" && action !== "close") return depth.respond(await c.notFound());
  await changeProjectStatus(c.env.DB, depth.project, action === "close", new Date());
  return depth.respond(new Response(null, { status: 303, headers: { location: projectLinkOf(depth.owner, depth.project) } }));
}

/** POST /{owner}/-/projects/{id}/columns/new (AddColumnToProjectPost): the
 *  board re-renders at 200 with the message + the kept values on the
 *  binding/validation arms, 303s onto the board on success (upstream's
 *  JSONOK + JS reload). */
async function ownerProjectColumnNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, respond, owner, project } = depth;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404));
  const form = parseColumnForm(await readUrlEncodedForm(c.req.raw));
  const result = await createColumnFromForm(c.env.DB, project, viewer.id, form, new Date());
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: projectLinkOf(owner, project) } }));
  }
  const data = await loadProjectBoardData(c.env.DB, owner, project, viewer, url.origin, url.searchParams);
  return respond(c.html(renderProjectBoardPage({ ctx, data, columnForm: form, columnError: result.message }), 200));
}

/** POST /{owner}/-/projects/{id}/{columnID}/default (SetDefaultProjectColumn):
 *  a foreign column id 404-shells, success 303s onto the board. */
async function ownerProjectColumnDefaultSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { ctx, respond, owner, project } = depth;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  const columnId = depth.route.family === "owner-project-column-default" ? depth.route.columnId : undefined;
  if (columnId === undefined) return respond(await c.notFound());
  const result = await setProjectDefaultColumnFromForm(c.env.DB, project, columnId, new Date());
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: projectLinkOf(owner, project) } }));
}

/** The workflows prologue's shared tail: the ?workflow_id focus (an unknown
 *  id 404-shells — the slices.ContainsFunc arm), then the render (create
 *  form / focused edit form + the re-render error arm). The ?event
 *  validation is the GET handler's arm (the POST re-render must reach the
 *  page with the service's 422 message, never the 404 shell). */
async function workflowsReRender(
  c: Context<{ Bindings: Env }>,
  depth: Extract<ResolvedProjectDepth, { ok: true }>,
  form: WorkflowForm,
  error: string | null,
): Promise<Response> {
  const { url, ctx, viewer, respond, owner, project } = depth;
  const data = await loadProjectWorkflowsData(c.env.DB, owner, project, viewer, url.origin, url.searchParams);
  if (depth.route.workflowId !== undefined) {
    const focused = await findWorkflowByIdAndProject(c.env.DB, depth.route.workflowId, project.id);
    if (focused === null) return respond(c.html(renderNotFound(ctx), 404));
    data.workflowId = depth.route.workflowId;
  }
  return respond(c.html(renderProjectWorkflowsPage({ ctx, data, form, error }), 200));
}

/** The workflows rule form's empty create state (the GET's fresh form). */
function emptyWorkflowForm(event: string): WorkflowForm {
  return {
    event,
    enabled: true,
    enabledPresent: false,
    hasRuleFields: false,
    filters: { issue_type: "", source_column_id: 0, target_column_id: 0, label_ids: [] },
    actions: { column_id: 0, add_label_ids: [], remove_label_ids: [], issue_state: "" },
  };
}

/** GET /{owner}/-/projects/{id}/workflows[/{wid}] (org.ProjectWorkflows →
 *  RenderWorkflows) — the read group gates it; the edit arms ride canManage
 *  inside the render. An unknown `?event=` preselect 404-shells
 *  (RenderWorkflows' workflow.go:48-52 arm). */
async function ownerProjectWorkflowsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const event = depth.url.searchParams.get("event");
  if (event !== null && event !== "" && !WORKFLOW_EVENTS.some((entry) => entry.event === event)) {
    return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  }
  return workflowsReRender(c, depth, emptyWorkflowForm(event ?? ""), null);
}

/** The workflows writes' second-layer gate (CanManageWorkflows —
 *  workflow.go:27-48): a projects writer who is not the org owner / the
 *  user owner 404-shells (upstream answers the service's JSONError 403; the
 *  landed gate posture is the uniform not-found shell). */
async function ownerProjectManageGate(
  c: Context<{ Bindings: Env }>,
  depth: Extract<ResolvedProjectDepth, { ok: true }>,
): Promise<Response | null> {
  const writeGate = await ownerProjectWriteGate(c, depth);
  if (writeGate !== null) return writeGate;
  const doer = boardDoer(depth.viewer);
  const canManage =
    depth.owner.kind === "org"
      ? await canManageOrgProjectWorkflows(c.env.DB, depth.owner.org, { id: doer.id ?? 0, isAdmin: doer.isAdmin })
      : canManageUserProjectWorkflows(depth.project, { id: doer.id ?? 0 });
  if (!canManage) return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  return null;
}

/** POST /{owner}/-/projects/{id}/workflows (CreateWorkflow): the service
 *  422s re-render at 200, success 303s onto the workflows page (upstream's
 *  JSON body + JS reload). */
async function ownerProjectWorkflowCreateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const manageGate = await ownerProjectManageGate(c, depth);
  if (manageGate !== null) return manageGate;
  const form = parseWorkflowForm(await readUrlEncodedForm(c.req.raw));
  const result = await createWorkflowFromForm(c.env.DB, depth.owner, depth.project, form, new Date());
  if (result.outcome === "created") {
    return depth.respond(new Response(null, { status: 303, headers: { location: `${depth.ownerLink}/workflows` } }));
  }
  return workflowsReRender(c, depth, form, result.message);
}

/** POST /{owner}/-/projects/{id}/workflows/{wid} (UpdateWorkflow): the same
 *  ladder; the quick enable/disable toggle POSTs only `enabled` and keeps
 *  the stored rules (the replace-vs-toggle contract). */
async function ownerProjectWorkflowUpdateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const manageGate = await ownerProjectManageGate(c, depth);
  if (manageGate !== null) return manageGate;
  const workflowId = depth.route.family === "owner-project-workflows" ? depth.route.workflowId : undefined;
  if (workflowId === undefined) return depth.respond(await c.notFound());
  const workflow = await findWorkflowByIdAndProject(c.env.DB, workflowId, depth.project.id);
  if (workflow === null) return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  const form = parseWorkflowForm(await readUrlEncodedForm(c.req.raw));
  const result = await updateWorkflowFromForm(c.env.DB, depth.owner, depth.project, workflow, form, new Date());
  if (result.outcome === "updated") {
    return depth.respond(new Response(null, { status: 303, headers: { location: `${depth.ownerLink}/workflows` } }));
  }
  return workflowsReRender(c, depth, form, result.message);
}

/** POST /{owner}/-/projects/{id}/workflows/{wid}/delete (DeleteWorkflow):
 *  the same ladder, then the 303 onto the workflows page. */
async function ownerProjectWorkflowDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const manageGate = await ownerProjectManageGate(c, depth);
  if (manageGate !== null) return manageGate;
  const workflowId = depth.route.family === "owner-project-workflow-delete" ? depth.route.workflowId : undefined;
  if (workflowId === undefined) return depth.respond(await c.notFound());
  const result = await deleteWorkflowFromForm(c.env.DB, depth.project, workflowId);
  if (result.outcome === "missing") return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  return depth.respond(new Response(null, { status: 303, headers: { location: `${depth.ownerLink}/workflows` } }));
}

// ---------------------------------------------------------------------------
// The wave-24 collaboration settings family (pages/settings-collaboration.tsx
// — upstream's /settings/collaboration group, web.go:1194-1204): the panel
// GET plus the five POST writes, every one behind the shared settingsGate
// and the §2.8 sameOriginGuard.
// ---------------------------------------------------------------------------

/** The collaboration re-render's shared tail: the fresh read, the failure
 *  message and the kept `collaborator` submission (the hooks-settings
 *  convention — validation failures re-render at 200). */
async function collaborationReRender(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
  options: { error: string | null; collaborator: string },
): Promise<Response> {
  const { ctx, viewer, respond, repo } = resolved;
  const data = await loadCollaborationData(c.env, c.env.DB, repo, viewer);
  return respond(c.html(renderCollaborationPage(ctx, data, options), 200));
}

/** GET /{owner}/{repo}/settings/collaboration (the panel). */
async function collaborationPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  return collaborationReRender(c, resolved, { error: null, collaborator: "" });
}

/**
 * POST /{owner}/{repo}/settings/collaboration — the add-collaborator write
 * (upstream CollaborationPost): success and the silent arms 303 back onto
 * the panel, the refused arms re-render with upstream's exact flash text
 * and the kept submission.
 */
async function collaborationAddSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  const name = (await readUrlEncodedForm(c.req.raw)).get("collaborator") ?? "";
  const result = await addCollaboratorFromForm(c.env.DB, repo, name, new Date());
  if (result.outcome !== "refused") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/collaboration` } }));
  }
  return collaborationReRender(c, resolved, { error: result.message, collaborator: name });
}

/** POST /{owner}/{repo}/settings/collaboration/access_mode — the access-mode
 *  write (upstream ChangeCollaborationAccessMode). */
async function collaborationAccessModeSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  const form = await readUrlEncodedForm(c.req.raw);
  const result = await changeAccessModeFromForm(c.env.DB, repo, form, new Date());
  if (result.outcome !== "refused") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/collaboration` } }));
  }
  return collaborationReRender(c, resolved, { error: result.message, collaborator: "" });
}

/** POST /{owner}/{repo}/settings/collaboration/delete — the remove write
 *  (upstream DeleteCollaboration). */
async function collaborationDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  const form = await readUrlEncodedForm(c.req.raw);
  const result = await removeCollaboratorFromForm(c.env.DB, repo, form);
  if (result.outcome !== "refused") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/collaboration` } }));
  }
  return collaborationReRender(c, resolved, { error: result.message, collaborator: "" });
}

/** POST /{owner}/{repo}/settings/collaboration/team — the add-team write
 *  (upstream AddTeamPost, behind CanDoerManageOrgRepoCollaboratorTeam). */
async function collaborationTeamAddSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, viewer, respond, repo } = resolved;
  if (!(await canChangeRepoTeamAccess(c.env, c.env.DB, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const form = await readUrlEncodedForm(c.req.raw);
  const result = await addTeamFromForm(c.env.DB, repo, form);
  if (result.outcome !== "refused") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/collaboration` } }));
  }
  return collaborationReRender(c, resolved, { error: result.message, collaborator: "" });
}

/** POST /{owner}/{repo}/settings/collaboration/team/delete — the remove-team
 *  write (upstream DeleteTeam, the same team gate). */
async function collaborationTeamDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, viewer, respond, repo } = resolved;
  if (!(await canChangeRepoTeamAccess(c.env, c.env.DB, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const form = await readUrlEncodedForm(c.req.raw);
  const result = await removeTeamFromForm(c.env.DB, repo, form);
  if (result.outcome !== "refused") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/collaboration` } }));
  }
  return collaborationReRender(c, resolved, { error: result.message, collaborator: "" });
}

// ---------------------------------------------------------------------------
// The wave-25 repo labels writes (pages/repo-labels.tsx — upstream's
// /labels group, web.go:1417-1422, over the landed repo-label family). The
// shared gate is the module header's port of reqRepoIssuesOrPullsWriter:
// anonymous → the login 303 (reqSignIn), an archived repo or a signed-in
// non-writer → the 404 shell (RepoMustNotBeArchived + the writer arm —
// `canWriteRepo`, the same predicate the page's render gate evaluates).
// ---------------------------------------------------------------------------

/** The labels write gate (the order above; `null` = proceed). */
async function repoLabelsWriteGate(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
): Promise<Response | null> {
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (repo.isArchived || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  return null;
}

/** The create/edit failure re-render's shared tail: the fresh read, the
 *  failure message and the kept create-form submission (the org-labels
 *  handlers' convention — validation failures re-render at 200). */
async function repoLabelsReRender(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
  options: { error: string | null; form: { title: string; color: string } },
): Promise<Response> {
  const { ctx, viewer, respond, repo } = resolved;
  const data = await loadRepoLabelsData(c.env, c.env.DB, repo, viewer, new URLSearchParams());
  return respond(c.html(renderRepoLabelsPage({ ctx, data, form: options.form, error: options.error }), 200));
}

/** GET /{owner}/{repo}/labels (pages/repo-labels.tsx — the management list;
 *  anonymous-capable, upstream's optSignIn + reqRepoIssuesOrPullsReader
 *  group). */
async function repoLabelsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "repo-labels") return respond(await c.notFound()); // drift guard
  const data = await loadRepoLabelsData(c.env, c.env.DB, repo, viewer, url.searchParams);
  return respond(
    c.html(renderRepoLabelsPage({ ctx, data, form: { title: "", color: NEW_LABEL_DEFAULT_COLOR }, error: null }), 200),
  );
}

/**
 * POST /{owner}/{repo}/labels/new (upstream repo.NewLabel over the landed
 * create arm): the §2.8 Origin guard, the write gate, then the
 * empty-title guard + `normalizeLabelColor` + `createRepoLabel` — success
 * 303s back onto the list (upstream JSONRedirect's target), the failures
 * re-render at 200 with the message and the kept submission (the org-labels
 * convention).
 */
async function repoLabelNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoLabelsWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  if (resolved.route.family !== "repo-label-new") return respond(await c.notFound()); // drift guard
  const form = parseRepoLabelForm(await readUrlEncodedForm(c.req.raw));
  const result = await createRepoLabelFromForm(c.env.DB, repo.id, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/labels` } }));
  }
  return repoLabelsReRender(c, resolved, { error: result.message, form });
}

/**
 * POST /{owner}/{repo}/labels/edit (upstream repo.UpdateLabel over the
 * landed edit arm's order — the repo-scoped lookup before any color 422):
 * success 303s back onto the list; a missing/foreign id 404-shells (the
 * landed PATCH arm's plain "not found" — upstream's JSONErrorNotFound);
 * the failures re-render with the error banner and the STORED row values
 * (pages/repo-labels.tsx's re-render note).
 */
async function repoLabelEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoLabelsWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  if (resolved.route.family !== "repo-label-edit") return respond(await c.notFound()); // drift guard
  const params = await readUrlEncodedForm(c.req.raw);
  const form = parseRepoLabelForm(params);
  const result = await editRepoLabelFromForm(c.env.DB, repo.id, formLabelId(params.get("id")), form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/labels` } }));
  }
  if (result.outcome === "missing") return respond(c.html(renderNotFound(resolved.ctx), 404));
  return repoLabelsReRender(c, resolved, { error: result.message, form: { title: "", color: NEW_LABEL_DEFAULT_COLOR } });
}

/**
 * POST /{owner}/{repo}/labels/delete (upstream repo.DeleteLabel over the
 * landed cascade arm): the repo-scoped lookup, the delete when the row
 * exists, SUCCESS either way (the arm's zero-row 204 and upstream's
 * unconditional JSONRedirect) — both arms 303 back onto the list.
 */
async function repoLabelDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoLabelsWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  if (resolved.route.family !== "repo-label-delete") return respond(await c.notFound()); // drift guard
  const params = await readUrlEncodedForm(c.req.raw);
  await deleteRepoLabelFromForm(c.env.DB, repo.id, formLabelId(params.get("id")));
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/labels` } }));
}

// ---------------------------------------------------------------------------
// The wave-45 repo projects surface (pages/repo-projects.tsx — upstream's
// /{username}/{reponame}/projects group, web.go:1544-1563, the survey's
// re-ranked #1): the list + board + write group + workflow tails over the
// landed repo-scope service arms. Every family rides resolveUiRequest (the
// §2.5 repo read — the requireVisibleRepo family; the wave-24 collaboration
// handlers' composition), then the unit toggle, then — writes only — the
// shared repo write ladder.
// ---------------------------------------------------------------------------

/** The wave-45 families' guard — the prologue accepts exactly these. */
function isRepoProjectsRoute(route: ParsedUiRoute): route is RepoProjectsRoute {
  return (
    route.family === "repo-projects" ||
    route.family === "repo-project-new" ||
    route.family === "repo-project-board" ||
    route.family === "repo-project-edit" ||
    route.family === "repo-project-delete" ||
    route.family === "repo-project-status" ||
    route.family === "repo-project-column-new" ||
    route.family === "repo-project-column-default" ||
    route.family === "repo-project-workflows" ||
    route.family === "repo-project-workflow-delete"
  );
}

type ResolvedRepoProjects = Extract<ResolvedUiRequest, { ok: true }> & { route: RepoProjectsRoute };

/**
 * The group's shared prologue: the repo resolution (invisible repo → the
 * 404 shell), then `repo.MustEnableRepoProjects` (repo/projects.go:43-58)
 * reduced to the loaded `repoHasProjects` toggle (the read group's last
 * arm; a disabled unit is the NotFound shell — the tab rides the same flag).
 */
async function resolveRepoProjectsRequest(
  c: Context<{ Bindings: Env }>,
): Promise<ResolvedRepoProjects | { ok: false; response: Response }> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved;
  if (!isRepoProjectsRoute(resolved.route)) return { ok: false, response: await c.notFound() }; // drift guard
  if (resolved.ctx.repoHasProjects !== true) {
    return { ok: false, response: resolved.respond(c.html(renderNotFound(resolved.ctx), 404)) };
  }
  return { ...resolved, route: resolved.route };
}

/**
 * The write group's gate (web.go:1562's reqRepoProjectsWriter +
 * RepoMustNotBeArchived): the same ladder the wave-25 labels writes run —
 * anonymous → the login 303, an archived repo or a signed-in non-writer →
 * the 404 shell — reused verbatim. CanManageWorkflows' repo arm (the
 * workflows' second layer, workflow.go:24-31) collapses into the same
 * repo-wide writer (routes/projects-repo.ts's requireWorkflowManager
 * reduction), so this one gate covers the workflow writes too.
 */
const repoProjectsWriteGate = repoLabelsWriteGate;

/**
 * The {id} families' shared depth: the group prologue, then the repo-scoped
 * project read (GetProjectByID over `repoProjectScope(repo.id)` — another
 * repo's id reads as not found, the upstream handlers' RepoID-mismatch arm
 * folded into the scope condition). `route.id ?? 0` — the list/new families
 * never reach here, and id 0 matches no row.
 */
async function resolveRepoProjectDepth(
  c: Context<{ Bindings: Env }>,
): Promise<Extract<ResolvedRepoProjects, { ok: true }> & { project: ProjectRow } | { ok: false; response: Response }> {
  const resolved = await resolveRepoProjectsRequest(c);
  if (!resolved.ok) return resolved;
  const project = await findProjectById(c.env.DB, repoProjectScope(resolved.repo.id), resolved.route.id ?? 0);
  if (project === null) return { ok: false, response: resolved.respond(c.html(renderNotFound(resolved.ctx), 404)) };
  return { ...resolved, project };
}

/** GET /{owner}/{repo}/projects (repo.Projects — the list; every viewer who
 *  can see the repo with the unit enabled). */
async function repoProjectsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveRepoProjectsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond, route } = resolved;
  if (route.family !== "repo-projects") return respond(await c.notFound()); // drift guard
  const data = await loadRepoProjectsData(c.env, c.env.DB, repo, viewer, url.searchParams);
  return respond(c.html(renderRepoProjectsPage(ctx, data), 200));
}

/** GET /{owner}/{repo}/projects/new (repo.RenderNewProject — the write
 *  group's form; the gate is the route group's, run before any render). */
async function repoProjectNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveRepoProjectsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond, route } = resolved;
  if (route.family !== "repo-project-new") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, resolved);
  if (gate !== null) return gate;
  return respond(
    c.html(
      renderRepoProjectNewPage({ ctx, repo, form: { title: "", content: "", templateType: "", cardType: "" }, error: null }),
      200,
    ),
  );
}

/** POST /{owner}/{repo}/projects/new (repo.NewProjectPost): success 303s
 *  onto the LIST (upstream's RepoLink+/projects Redirect), the binding
 *  failures re-render at 200 with the message and the kept submission. */
async function repoProjectNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveRepoProjectsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond, route } = resolved;
  if (route.family !== "repo-project-new") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, resolved);
  if (gate !== null) return gate;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404));
  const form = parseProjectForm(await readUrlEncodedForm(c.req.raw));
  const result = await createRepoProjectFromForm(c.env.DB, repo, viewer.id, form, new Date());
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/projects` } }));
  }
  return respond(c.html(renderRepoProjectNewPage({ ctx, repo, form, error: result.message }), 200));
}

/** GET /{owner}/{repo}/projects/{id} (repo.ViewProject — the board). */
async function repoProjectBoardPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, repo, respond, route, project } = depth;
  if (route.family !== "repo-project-board") return respond(await c.notFound()); // drift guard
  const data = await loadRepoProjectBoardData(c.env, c.env.DB, repo, project, viewer, url.searchParams);
  return respond(
    c.html(renderRepoProjectBoardPage({ ctx, data, columnForm: { title: "", color: "" }, columnError: null }), 200),
  );
}

/** GET /{owner}/{repo}/projects/{id}/edit (repo.RenderEditProject — the
 *  pre-filled shared form; `?redirect=project` rides the hidden field). */
async function repoProjectEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, repo, respond, route, project } = depth;
  if (route.family !== "repo-project-edit") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const data = await loadRepoProjectBoardData(c.env, c.env.DB, repo, project, depth.viewer, new URLSearchParams());
  return respond(
    c.html(
      renderRepoProjectEditPage({
        ctx,
        data,
        form: {
          title: project.title,
          content: project.description,
          templateType: "",
          cardType: cardTypeToString(project.cardType),
        },
        error: null,
        redirect: url.searchParams.get("redirect") ?? "",
      }),
      200,
    ),
  );
}

/** POST /{owner}/{repo}/projects/{id}/edit (repo.EditProjectPost): success
 *  303s onto the board when the hidden `redirect=project` rode (upstream's
 *  p.Link() Redirect), else onto the LIST; failures re-render at 200. */
async function repoProjectEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { ctx, viewer, repo, respond, route, project } = depth;
  if (route.family !== "repo-project-edit") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const formParams = await readUrlEncodedForm(c.req.raw);
  const form = parseProjectForm(formParams);
  const result = await updateProjectFromForm(c.env.DB, project, form, new Date());
  if (result.outcome === "updated") {
    const target =
      formParams.get("redirect") === "project" ? repoProjectLink(repo, project) : `${repoLinkOf(repo)}/projects`;
    return respond(new Response(null, { status: 303, headers: { location: target } }));
  }
  const data = await loadRepoProjectBoardData(c.env, c.env.DB, repo, project, viewer, new URLSearchParams());
  return respond(
    c.html(
      renderRepoProjectEditPage({
        ctx,
        data,
        form,
        error: result.message,
        redirect: formParams.get("redirect") ?? "",
      }),
      200,
    ),
  );
}

/** POST /{owner}/{repo}/projects/{id}/delete (repo.DeleteProject): the
 *  cascade delete then the 303 onto the LIST (upstream's JSONRedirect
 *  target). */
async function repoProjectDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route, project } = depth;
  if (route.family !== "repo-project-delete") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  await deleteProjectById(c.env.DB, project.id);
  return depth.respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(depth.repo)}/projects` } }));
}

/** POST /{owner}/{repo}/projects/{id}/open|close
 *  (repo.ChangeProjectStatus): the guarded flip then the 303 onto the board
 *  (upstream's JSONRedirect → ProjectLinkForRepo). */
async function repoProjectStatusSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route, project } = depth;
  if (route.family !== "repo-project-status") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const action = route.action;
  if (action !== "open" && action !== "close") return depth.respond(await c.notFound());
  await changeProjectStatus(c.env.DB, project, action === "close", new Date());
  return depth.respond(new Response(null, { status: 303, headers: { location: repoProjectLink(depth.repo, project) } }));
}

/** POST /{owner}/{repo}/projects/{id}/columns/new
 *  (repo.AddColumnToProjectPost via addProjectBoardRoutes): the board
 *  re-renders at 200 with the message + kept values on the failure arms,
 *  303s onto the board on success. */
async function repoProjectColumnNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, repo, respond, route, project } = depth;
  if (route.family !== "repo-project-column-new") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404));
  const form = parseColumnForm(await readUrlEncodedForm(c.req.raw));
  const result = await createColumnFromForm(c.env.DB, project, viewer.id, form, new Date());
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: repoProjectLink(repo, project) } }));
  }
  const data = await loadRepoProjectBoardData(c.env, c.env.DB, repo, project, viewer, url.searchParams);
  return respond(c.html(renderRepoProjectBoardPage({ ctx, data, columnForm: form, columnError: result.message }), 200));
}

/** POST /{owner}/{repo}/projects/{id}/{columnID}/default
 *  (repo.SetDefaultProjectColumn): a foreign column id 404-shells, success
 *  303s onto the board. */
async function repoProjectColumnDefaultSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { ctx, respond, route, project } = depth;
  if (route.family !== "repo-project-column-default") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const columnId = route.columnId;
  if (columnId === undefined) return respond(await c.notFound());
  const result = await setProjectDefaultColumnFromForm(c.env.DB, project, columnId, new Date());
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return depth.respond(new Response(null, { status: 303, headers: { location: repoProjectLink(depth.repo, project) } }));
}

/** The workflows re-render's shared tail (the ?workflow_id focus — an
 *  unknown id 404-shells, RenderWorkflows' slices.ContainsFunc arm — then
 *  the page). The ?event validation is the GET handler's arm (the POST
 *  re-render must reach the page with the service's 422 message). */
async function repoProjectWorkflowsReRender(
  c: Context<{ Bindings: Env }>,
  depth: Extract<ResolvedRepoProjects, { ok: true }> & { project: ProjectRow },
  form: WorkflowForm,
  error: string | null,
): Promise<Response> {
  const { url, ctx, viewer, repo, respond } = depth;
  const data = await loadRepoProjectWorkflowsData(c.env, c.env.DB, repo, depth.project, viewer, url.searchParams);
  if (depth.route.workflowId !== undefined) {
    const focused = await findWorkflowByIdAndProject(c.env.DB, depth.route.workflowId, depth.project.id);
    if (focused === null) return respond(c.html(renderNotFound(ctx), 404));
    data.workflowId = depth.route.workflowId;
  }
  return respond(c.html(renderRepoProjectWorkflowsPage({ ctx, data, form, error }), 200));
}

/** GET /{owner}/{repo}/projects/{id}/workflows[/{wid}]
 *  (repo.ProjectWorkflows → RenderWorkflows) — the read group gates it; the
 *  edit arms ride canManage inside the render (the repo arm's collapse into
 *  the writer grant — the page module's gate note). An unknown `?event=`
 *  preselect 404-shells. */
async function repoProjectWorkflowsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route } = depth;
  if (route.family !== "repo-project-workflows") return respond(await c.notFound()); // drift guard
  const event = depth.url.searchParams.get("event");
  if (event !== null && event !== "" && !WORKFLOW_EVENTS.some((entry) => entry.event === event)) {
    return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  }
  return repoProjectWorkflowsReRender(c, depth, emptyWorkflowForm(event ?? ""), null);
}

/** POST /{owner}/{repo}/projects/{id}/workflows (CreateWorkflow): the
 *  service 422s re-render at 200, success 303s onto the workflows page. */
async function repoProjectWorkflowCreateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route } = depth;
  if (route.family !== "repo-project-workflows") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const form = parseWorkflowForm(await readUrlEncodedForm(c.req.raw));
  const result = await createRepoWorkflowFromForm(c.env.DB, depth.repo, depth.project, form, new Date());
  if (result.outcome === "created") {
    return depth.respond(
      new Response(null, { status: 303, headers: { location: `${repoProjectLink(depth.repo, depth.project)}/workflows` } }),
    );
  }
  return repoProjectWorkflowsReRender(c, depth, form, result.message);
}

/** POST /{owner}/{repo}/projects/{id}/workflows/{wid} (UpdateWorkflow): the
 *  same ladder; the quick enable/disable toggle POSTs only `enabled` and
 *  keeps the stored rules (the replace-vs-toggle contract). */
async function repoProjectWorkflowUpdateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route } = depth;
  if (route.family !== "repo-project-workflows" || route.workflowId === undefined) {
    return respond(await c.notFound()); // drift guard
  }
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const workflow = await findWorkflowByIdAndProject(c.env.DB, route.workflowId, depth.project.id);
  if (workflow === null) return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  const form = parseWorkflowForm(await readUrlEncodedForm(c.req.raw));
  const result = await updateRepoWorkflowFromForm(c.env.DB, depth.repo, depth.project, workflow, form, new Date());
  if (result.outcome === "updated") {
    return depth.respond(
      new Response(null, { status: 303, headers: { location: `${repoProjectLink(depth.repo, depth.project)}/workflows` } }),
    );
  }
  return repoProjectWorkflowsReRender(c, depth, form, result.message);
}

/** POST /{owner}/{repo}/projects/{id}/workflows/{wid}/delete
 *  (DeleteWorkflow): the same ladder, then the 303 onto the workflows page;
 *  a foreign/unknown id 404-shells. */
async function repoProjectWorkflowDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route } = depth;
  if (route.family !== "repo-project-workflow-delete" || route.workflowId === undefined) {
    return respond(await c.notFound()); // drift guard
  }
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const result = await deleteWorkflowFromForm(c.env.DB, depth.project, route.workflowId);
  if (result.outcome === "missing") return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  return depth.respond(
    new Response(null, { status: 303, headers: { location: `${repoProjectLink(depth.repo, depth.project)}/workflows` } }),
  );
}

// ---------------------------------------------------------------------------
// The wave-26 milestone detail + edit (pages/milestone-detail.tsx —
// upstream web.go:1340's reader route and web.go:1427-1428's writer combo)
// and the fork form (pages/repo-fork.tsx — web.go:1490's combo over the
// landed createFork machinery)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/milestone/{id} (pages/milestone-detail.tsx — the
 *  milestone's issues-and-pulls list; every viewer who can see the repo; the
 *  write predicate rides along for the Edit button). */
async function milestoneDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (resolved.route.family !== "milestone-detail") return respond(await c.notFound()); // drift guard
  const data = await loadMilestoneDetailData(c.env.DB, repo, resolved.route.id, url.searchParams, ctx.origin);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  // reqRepoIssuesOrPullsWriter's landed port (the wave-25 labels page's
  // predicate — NOT the milestone-new module's older admin reduction); the
  // page hides every control on archived repos itself (upstream's
  // `if not .Repository.IsArchived` wrapper).
  data.canWrite = await canWriteRepo(c.env, repo, viewer);
  return respond(c.html(renderMilestoneDetailPage(ctx, data), 200));
}

/** The milestone edit gate — upstream's write group (reqSignIn +
 *  RepoMustNotBeArchived + reqRepoIssuesOrPullsWriter) is EXACTLY the
 *  labels-write gate's order, so the landed `repoLabelsWriteGate` runs
 *  verbatim: anonymous → the login 303 (repo resolution FIRST), an archived
 *  repo or a signed-in non-writer → the 404 shell. */

/** GET /{owner}/{repo}/milestones/{id}/edit (pages/milestone-detail.tsx —
 *  the form, the stored values prefilled). */
async function milestoneEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoLabelsWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, respond, repo } = resolved;
  if (resolved.route.family !== "milestone-edit") return respond(await c.notFound()); // drift guard
  const data = await loadMilestoneEditData(c.env.DB, repo.id, resolved.route.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    c.html(
      renderMilestoneEditPage({ ctx, milestone: data.milestone, form: milestoneEditFormOf(data.milestone), error: null }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/milestones/{id}/edit (upstream EditMilestonePost):
 * the §2.8 Origin guard, the write gate, the repo-scoped milestone lookup
 * (missing/foreign id 404-shells — the handler's own GetMilestoneByRepoID
 * order), then the landed `editRepoMilestone` — success 303s back onto the
 * list (upstream's redirect), validation failures re-render at 200 with the
 * message and the kept values (the login failure convention).
 */
async function milestoneEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoLabelsWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, respond, repo } = resolved;
  if (resolved.route.family !== "milestone-edit") return respond(await c.notFound()); // drift guard
  const data = await loadMilestoneEditData(c.env.DB, repo.id, resolved.route.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseMilestoneForm(await readUrlEncodedForm(c.req.raw));
  const result = await editMilestoneFromForm(c.env.DB, data.milestone.id, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/milestones` } }));
  }
  return respond(c.html(renderMilestoneEditPage({ ctx, milestone: data.milestone, form, error: result.message }), 200));
}

/** GET /{owner}/{repo}/fork (pages/repo-fork.tsx — the form). The combo's
 *  gate order: repo resolution FIRST (invisible repos 404 before the
 *  redirect could leak), then reqSignIn's login 303, then
 *  getForkRepository's IsEmpty arm (an empty source has nothing to fork). */
async function repoForkPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (resolved.route.family !== "repo-fork") return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadRepoForkData(c.env, c.env.DB, repo, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    c.html(renderRepoForkPage({ ctx, data, form: { uid: data.selectedId, name: data.source.repo.slug }, error: null }), 200),
  );
}

/**
 * POST /{owner}/{repo}/fork (upstream ForkPost): the §2.8 Origin guard, the
 * GET's gate order, then the landed POST /repos/{owner}/{repo}/forks
 * route's exact service sequence through createForkFromForm — success 303s
 * onto the fork's home (upstream's JSONRedirect target), an EXISTING fork
 * 303s onto its home (the GetUserFork arm), validation failures re-render
 * at 200 with the message and the kept values.
 */
async function repoForkSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (resolved.route.family !== "repo-fork") return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname));
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadRepoForkData(c.env, c.env.DB, repo, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseRepoForkForm(await readUrlEncodedForm(c.req.raw));
  const result = await createForkFromForm(c.env, c.env.DB, viewer, data, form);
  if (result.outcome === "existing") {
    return respond(new Response(null, { status: 303, headers: { location: result.location } }));
  }
  if (result.outcome === "created") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${result.ownerNamespace}/${result.slug}` } }),
    );
  }
  return respond(c.html(renderRepoForkPage({ ctx, data, form, error: result.message }), 200));
}

export const uiRouter = new Hono<{ Bindings: Env }>();

// §4.13: trailing-slash URLs redirect to the canonical form (we never emit
// them). Default mode rewrites only when the trimmed path matched a claimed
// route (the response was a 404), so it cannot launder unclaimed paths.
uiRouter.use(trimTrailingSlash());

// The claimed families (§2.1), registered exactly as parseUiRoute classifies
// them so the sub-app's reach equals handlesUiRoute's. HEAD is intentionally
// unregistered (GET-only surface, §2.1): a HEAD request misses into the
// parent app's plain 404 — identical to today's engine answer for these
// paths.
//
// Wave-9 site families register FIRST, physically before every dynamic
// family: the explore literals (/explore, /explore/repos, /explore/users)
// and the site root must win against /:owner/:repo and the owner regex —
// registration order is what makes the static-before-dynamic precedence
// local and obvious (the same rule the /issues/new literal follows below).
// Verified against this Hono pin's RegExpRouter: a static registered after
// the dynamic pair LOSES to it — /explore/repos would land in uiPage's
// drift guard and 404.
uiRouter.get("/", (c) => siteHomePage(c));
uiRouter.get("/explore", () => exploreRoot());
uiRouter.get("/explore/repos", (c) => exploreReposPage(c));
uiRouter.get("/explore/users", (c) => exploreUsersPage(c));
// Wave-10 notifications family (parseUiRoute claims exactly these literal
// shapes; registered with the wave-9 statics so the literals beat the
// dynamic owner/repo and owner regexes — the wave-9 RegExpRouter note). The
// POST-only write tails answer GET with chi's 405 (the same convention the
// comment/label write families carry).
uiRouter.get("/notifications", (c) => notificationsPage(c));
uiRouter.get("/notifications/new", (c) => notificationsNew(c));
uiRouter.post("/notifications/status", (c) => notificationStatusSubmit(c));
uiRouter.post("/notifications/purge", (c) => notificationPurgeSubmit(c));
uiRouter.get("/notifications/status", () => methodNotAllowed("POST"));
uiRouter.get("/notifications/purge", () => methodNotAllowed("POST"));
// Wave-12 families (parseUiRoute claims exactly these shapes; registered
// with the wave-9 statics so the literals beat the dynamic owner/repo and
// owner regexes — the wave-9 RegExpRouter note: a static registered after
// the dynamic pair LOSES to it, and /:owner/teams must beat /:owner/:repo
// the same way). The POST-only tails answer GET with chi's 405 posture is
// not needed here: /user/settings POST carries the literal GET above, and
// the teams POSTs hang off the /new literal's own GET+POST pair.
uiRouter.get("/user/settings", (c) => userSettingsPage(c));
// Window-2a: the tab families (each parse family's method arms — the
// modules' handoff recipes).
uiRouter.get("/user/settings/appearance", (c) => userSettingsAppearancePage(c));
uiRouter.post("/user/settings/appearance/theme", (c) => userSettingsAppearanceSubmit(c, "theme"));
uiRouter.post("/user/settings/appearance/language", (c) => userSettingsAppearanceSubmit(c, "language"));
uiRouter.get("/user/settings/security", (c) => userSettingsSecurityPage(c));
uiRouter.get("/user/settings/actions/secrets", (c) => userSettingsSecretsPage(c));
uiRouter.post("/user/settings/actions/secrets", (c) => userSettingsSecretsSubmit(c));
uiRouter.post("/user/settings/actions/secrets/delete", (c) => userSettingsSecretsDelete(c));
uiRouter.get("/user/settings/actions/variables", (c) => userSettingsVariablesPage(c));
uiRouter.post("/user/settings/actions/variables/new", (c) => userSettingsVariablesNew(c));
uiRouter.post("/user/settings/actions/variables/:id/edit", (c) => userSettingsVariablesEdit(c, Number(c.req.param("id"))));
uiRouter.post("/user/settings/actions/variables/:id/delete", (c) => userSettingsVariablesDelete(c, Number(c.req.param("id"))));
uiRouter.get("/user/settings/hooks", (c) => userSettingsHooksPage(c));
uiRouter.post("/user/settings/hooks", (c) => userSettingsHooksCreate(c));
uiRouter.get("/user/settings/hooks/:id", (c) => userHookDetailPage(c, Number(c.req.param("id"))));
uiRouter.post("/user/settings/hooks/:id", (c) => userHookDetailSubmit(c, Number(c.req.param("id"))));
uiRouter.post("/user/settings/hooks/:id/delete", (c) => userHookDelete(c, Number(c.req.param("id"))));
uiRouter.get("/user/settings/keys", (c) => userSettingsKeysPage(c));
uiRouter.post("/user/settings/keys", (c) => userSettingsKeysSubmit(c));
uiRouter.post("/user/settings/keys/delete", (c) => userSettingsKeysDelete(c));
uiRouter.get("/user/settings/applications", (c) => userSettingsApplicationsPage(c));
uiRouter.post("/user/settings/applications", (c) => userSettingsApplicationsSubmit(c));
uiRouter.post("/user/settings/applications/delete", (c) => userSettingsApplicationsDelete(c));
uiRouter.get("/user/settings/organization", (c) => userSettingsOrganizationsPage(c));
uiRouter.post("/user/settings/organization/leave", (c) => userSettingsOrganizationsLeave(c));
uiRouter.post("/user/settings", (c) => userSettingsSubmit(c));
// Wave-19 creation pages (parseUiRoute claims exactly these literal shapes —
// upstream's reqSignIn /repo/create + /org/create groups; registered with
// the wave-9/12 statics so the literals beat the dynamic owner/repo pair —
// the wave-9 RegExpRouter note). The POSTs run the §2.8 sameOriginGuard.
uiRouter.get("/repo/create", (c) => repoCreatePage(c));
uiRouter.post("/repo/create", (c) => repoCreateSubmit(c));
uiRouter.get("/org/create", (c) => orgCreatePage(c));
uiRouter.post("/org/create", (c) => orgCreateSubmit(c));
uiRouter.get("/:owner/teams", (c) => orgTeamsPage(c));
uiRouter.get("/:owner/teams/new", (c) => orgTeamNewPage(c));
uiRouter.post("/:owner/teams/new", (c) => orgTeamNewSubmit(c));
uiRouter.get("/:owner/teams/:id", (c) => orgTeamDetailPage(c));
// Wave-49 team edit + delete (parseUiRoute claims exactly these shapes —
// upstream web.go:1011-1013's edit combo and delete POST; the edit carries
// GET + POST, the delete tail answers GET with chi's 405 — the hook
// test/delete convention; the POSTs run the §2.8 sameOriginGuard first). No
// earlier registration can absorb these: the deeper :id/edit and :id/delete
// tails are 5-segment shapes the wave-12 lines do not carry, and the parser
// claims positive integers only.
uiRouter.get("/:owner/teams/:id/edit", (c) => orgTeamEditPage(c));
uiRouter.post("/:owner/teams/:id/edit", (c) => orgTeamEditSubmit(c));
uiRouter.post("/:owner/teams/:id/delete", (c) => orgTeamDeleteSubmit(c));
uiRouter.get("/:owner/teams/:id/delete", () => methodNotAllowed("POST"));
// Wave-49 org settings family (parseUiRoute claims exactly these shapes —
// upstream web.go:1017-1092's /settings subtree: the options combo (GET +
// POST), the avatar write pair and the danger-zone rename/delete/visibility
// POST segments; the POST-only tails answer GET with chi's 405 — the
// hook-test convention, and the POSTs run the §2.8 sameOriginGuard first).
// The literal `settings` registers with the wave-9/12 statics so it beats
// the dynamic /:owner/:repo pair — upstream's require-owner /{org} group
// registers ahead of :1292 and shadows a repository named "settings"
// identically (the teams/labels precedent; a non-owner's hit 404-shells at
// the handler, upstream's RequireOwner OrgAssignment NotFound). No other
// registration can absorb the deeper literals: /:owner/:repo/settings (the
// repo family) needs the literal third segment, and no registered
// /:owner/:repo/{X} line carries rename/delete/visibility/avatar as X.
uiRouter.get("/:owner/settings", (c) => orgSettingsPage(c));
uiRouter.post("/:owner/settings", (c) => orgSettingsSubmit(c));
uiRouter.post("/:owner/settings/avatar", (c) => orgSettingsAvatarSubmit(c));
uiRouter.get("/:owner/settings/avatar", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/avatar/delete", (c) => orgSettingsAvatarDeleteSubmit(c));
uiRouter.get("/:owner/settings/avatar/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/rename", (c) => orgSettingsRenameSubmit(c));
uiRouter.get("/:owner/settings/rename", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/delete", (c) => orgSettingsDeleteSubmit(c));
uiRouter.get("/:owner/settings/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/visibility", (c) => orgSettingsVisibilitySubmit(c));
uiRouter.get("/:owner/settings/visibility", () => methodNotAllowed("POST"));
// Wave-53 org settings hooks tab (parseUiRoute claims exactly these
// shapes — web.go:1033-1044's /hooks group). No earlier registration can
// absorb these: /:owner/settings/hooks is a 4-segment literal-second
// shape (every /:owner/:repo/settings* line needs FIVE segments, and no
// other 4-segment line carries a "settings" second segment), the {id}
// tails are deeper still, and the GET on the POST-only delete tail
// answers chi's 405 (the repo hooks-family convention).
uiRouter.get("/:owner/settings/hooks", (c) => orgHooksSettingsPage(c));
uiRouter.post("/:owner/settings/hooks", (c) => orgHooksSettingsSubmit(c));
uiRouter.get("/:owner/settings/hooks/:id", (c) => orgHookDetailPage(c));
uiRouter.post("/:owner/settings/hooks/:id", (c) => orgHookDetailSubmit(c));
uiRouter.post("/:owner/settings/hooks/:id/delete", (c) => orgHookDeleteSubmit(c));
// Window-2b: the blocked_users tab + the actions sub-tabs.
uiRouter.get("/:owner/settings/blocked_users", (c) => orgBlockedUsersPage(c));
uiRouter.post("/:owner/settings/blocked_users", (c) => orgBlockedUsersSubmit(c));
uiRouter.get("/:owner/settings/actions/secrets", (c) => orgActionsSecretsPage(c));
uiRouter.post("/:owner/settings/actions/secrets", (c) => orgActionsSecretsSubmit(c));
uiRouter.post("/:owner/settings/actions/secrets/delete", (c) => orgActionsSecretsDelete(c));
uiRouter.get("/:owner/settings/actions/variables", (c) => orgActionsVariablesPage(c));
uiRouter.post("/:owner/settings/actions/variables/new", (c) => orgActionsVariablesNew(c));
uiRouter.post("/:owner/settings/actions/variables/:id/edit", (c) => orgActionsVariablesEdit(c, Number(c.req.param("id"))));
uiRouter.post("/:owner/settings/actions/variables/:id/delete", (c) => orgActionsVariablesDelete(c, Number(c.req.param("id"))));
// Window-2c: the admin group.
uiRouter.get("/-/admin", (c) => adminDashboardPage(c));
uiRouter.post("/-/admin", (c) => adminDashboardSubmit(c));
uiRouter.get("/-/admin/monitor/stats", (c) => adminMonitorPage(c, "stats"));
uiRouter.get("/-/admin/monitor/cron", (c) => adminMonitorPage(c, "cron"));
uiRouter.post("/-/admin/monitor/cron", (c) => adminMonitorCronSubmit(c));
uiRouter.get("/-/admin/monitor/queue", (c) => adminMonitorPage(c, "queue"));
uiRouter.get("/-/admin/monitor/stacktrace", (c) => adminMonitorPage(c, "trace"));
uiRouter.get("/:owner/settings/hooks/:id/delete", () => methodNotAllowed("POST"));
// Wave-14 org labels family (parseUiRoute claims exactly these shapes; the
// literal `labels` registers with the wave-9/12 statics so it beats the
// dynamic /:owner/:repo pair — the wave-9 RegExpRouter note). The three
// POST-only write tails answer GET with chi's 405.
uiRouter.get("/:owner/labels", (c) => orgLabelsPage(c));
uiRouter.post("/:owner/labels/new", (c) => orgLabelNewSubmit(c));
uiRouter.get("/:owner/labels/new", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/labels/edit", (c) => orgLabelEditSubmit(c));
uiRouter.get("/:owner/labels/edit", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/labels/delete", (c) => orgLabelDeleteSubmit(c));
uiRouter.get("/:owner/labels/delete", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/commits", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/commits/*", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/src", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/src/*", (c) => uiPage(c));
// Wave-2 families (parseUiRoute claims exactly these shapes).
uiRouter.get("/:owner/:repo/tree", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/tree/*", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/issues", (c) => uiPage(c));
// The static literal registers before the dynamic :index so handler choice
// never depends on router precedence subtleties (Hono's RegExpRouter ranks
// static segments first; this makes it local and obvious).
uiRouter.get("/:owner/:repo/issues/new", (c) => issueNewPage(c));
uiRouter.post("/:owner/:repo/issues/new", (c) => issueNewSubmit(c));
// Wave-5 label-write family — same static-before-dynamic rule (the bare
// /issues/labels shape would otherwise be absorbed by issues/:index).
uiRouter.post("/:owner/:repo/issues/labels", (c) => issueLabelsSubmit(c));
uiRouter.get("/:owner/:repo/issues/labels", () => methodNotAllowed("POST"));
// Wave-11 review-write literals — the SAME static-before-dynamic rule (the
// wave-9 RegExpRouter note: a static registered after the dynamic :index
// LOSES to it). POSTs run the §2.8 sameOriginGuard; GET answers chi's 405.
uiRouter.post("/:owner/:repo/issues/request_review", (c) => pullReviewRequestSubmit(c));
uiRouter.get("/:owner/:repo/issues/request_review", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/issues/dismiss_review", (c) => pullReviewDismissSubmit(c));
uiRouter.get("/:owner/:repo/issues/dismiss_review", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo/issues/:index", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/pulls", (c) => uiPage(c));
// Wave-29 diffpatch downloads (parseUiRoute claims exactly the dotted
// `\\d+.{diff|patch}` tail — upstream web.go:1657-1658). The narrow dotted
// pattern registers BEFORE the broad :index line so first-match-wins keeps
// the undotted shapes with the page dispatch (verified against this Hono
// pin's getPattern greedy-brace regex; unclaimed shapes never reach the
// sub-app — the dispatcher consults handlesUiRoute first).
uiRouter.get("/:owner/:repo/pulls/:dpindex{(\\d+)\\.(?:diff|patch)}", (c) => diffpatchFileDownload(c));
uiRouter.get("/:owner/:repo/pulls/:index", (c) => uiPage(c));
// Wave-5 write/read families (parseUiRoute claims exactly these shapes;
// the POSTs run the §2.8 sameOriginGuard first — session.ts's convention).
// The POST-only families answer GET with chi's 405 (registered so the
// sub-app's reach equals handlesUiRoute's).
uiRouter.post("/:owner/:repo/issues/:index/comments", (c) => issueCommentSubmit(c));
uiRouter.post("/:owner/:repo/pulls/:index/comments", (c) => issueCommentSubmit(c));
uiRouter.get("/:owner/:repo/issues/:index/comments", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo/pulls/:index/comments", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo/pulls/:index/files", (c) => uiPage(c));
// The PR commits tab (parseUiRoute claims exactly this shape — GET only,
// like every read page).
uiRouter.get("/:owner/:repo/pulls/:index/commits", (c) => uiPage(c));
// Wave-11 verdict-form family (the deeper 4-segment tail under /files — no
// shorter POST/GET pattern can absorb it; the GET answers chi's 405).
	uiRouter.post("/:owner/:repo/pulls/:index/files/reviews/submit", (c) => pullReviewSubmit(c));
	uiRouter.get("/:owner/:repo/pulls/:index/files/reviews/submit", () => methodNotAllowed("POST"));
	// Wave-13 compare family (parseUiRoute claims exactly these shapes; the
	// bare URL is GET-only — upstream registers `m.Get("/compare")` outside
	// the POST path group, so a POST answers chi's 405 — and the form always
	// posts to the basehead URL). The POST runs the §2.8 sameOriginGuard.
	uiRouter.get("/:owner/:repo/compare", (c) => comparePage(c));
	uiRouter.post("/:owner/:repo/compare", () => methodNotAllowed("GET"));
	uiRouter.get("/:owner/:repo/compare/*", (c) => comparePage(c));
	uiRouter.post("/:owner/:repo/compare/*", (c) => compareSubmit(c));
// Wave-4 write families (parseUiRoute claims exactly these shapes; the
// POSTs run the §2.8 sameOriginGuard first — session.ts's convention).
uiRouter.get("/:owner/:repo/settings", (c) => settingsPage(c));
// Window-2d: the four settings tabs.
uiRouter.get("/:owner/:repo/settings/hooks/git", (c) => repoGitHooksPage(c));
uiRouter.get("/:owner/:repo/settings/hooks/git/:name", (c) => repoGitHookEditPage(c));
uiRouter.post("/:owner/:repo/settings/hooks/git/:name", (c) => repoGitHookSubmit(c));
uiRouter.get("/:owner/:repo/settings/tags", (c) => repoTagsPage(c));
uiRouter.post("/:owner/:repo/settings/tags", (c) => repoTagsSubmit(c));
uiRouter.post("/:owner/:repo/settings/tags/delete", (c) => repoTagDeleteSubmit(c));
uiRouter.get("/:owner/:repo/settings/tags/:id", (c) => repoTagDetailPage(c));
uiRouter.post("/:owner/:repo/settings/tags/:id", (c) => repoTagsSubmit(c));
uiRouter.get("/:owner/:repo/settings/keys", (c) => repoDeployKeysPage(c));
uiRouter.post("/:owner/:repo/settings/keys", (c) => repoDeployKeysSubmit(c));
uiRouter.post("/:owner/:repo/settings/keys/delete", (c) => repoDeployKeysDelete(c));
uiRouter.get("/:owner/:repo/settings/public_access", (c) => repoPublicAccessPage(c));
uiRouter.post("/:owner/:repo/settings/public_access", (c) => repoPublicAccessSubmit(c));
uiRouter.get("/:owner/:repo/settings/wiki", (c) => repoWikiSettingsPage(c));
uiRouter.post("/:owner/:repo/settings/wiki", (c) => repoWikiSettingsSubmit(c));
// Window-2e pass 1: sitemap + search aux.
uiRouter.get("/sitemap.xml", (c) => sitemapRoute(c));
uiRouter.get("/explore/repos/sitemap-:file", (c) => sitemapRoute(c));
uiRouter.get("/explore/users/sitemap-:file", (c) => sitemapRoute(c));
uiRouter.get("/repo/search", (c) => repoSearchAuxRoute(c));
uiRouter.get("/explore/topics/search", (c) => topicSearchAuxRoute(c));
// The feed suffixes — one constrained registration (the owner-home
// precedent); the parser discriminates .rss vs .atom and strips.
uiRouter.get("/:owner{^[\\w-]+\\.(rss|atom)$}", (c) => userFeedRoute(c));
// Window-2e B2: the repo-scoped aux/fragment routes.
uiRouter.get("/:owner/:repo/issues/search", (c) => issuesSearchAuxRoute(c));
uiRouter.get("/:owner/:repo/issues/suggestions", (c) => issuesSuggestionsAuxRoute(c));
uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/info", (c) => issueInfoFragmentRoute(c));
uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/attachments", (c) => issueAttachmentsFragmentRoute(c));
uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/attachments/:uuid", (c) => issueAttachmentsAliasRoute(c));
uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/content-history/overview", (c) => issueContentOverviewRoute(c));
uiRouter.get("/:owner/:repo/pulls/:index{\\d+}/merge_box", (c) => pullMergeBoxRoute(c));
uiRouter.get("/:owner/:repo/pulls/:index{\\d+}/files/:segment{^[a-f0-9]{7,64}(\\.\\.[a-f0-9]{7,64})?$}", (c) => pullFilesRangeRoute(c));
uiRouter.get("/:owner/:repo/pulls/:index{\\d+}/commits/:sha{^[a-f0-9]{7,64}$}", (c) => pullCommitFilesRoute(c));
uiRouter.get("/:owner/:repo/activity_author_data", (c) => activityAuthorDataRoute(c));
uiRouter.get("/:owner/:repo/activity_author_data/:period", (c) => activityAuthorDataRoute(c));
// Window-2e C1: the global inbox.
uiRouter.get("/issues", (c) => globalInboxIssuesPage(c, "issues"));
uiRouter.get("/pulls", (c) => globalInboxIssuesPage(c, "pulls"));
uiRouter.get("/milestones", (c) => globalMilestonesPage(c));
// Window-2e C2: the wiki family.
uiRouter.get("/:owner/:repo/wiki", (c) => wikiPage(c));
uiRouter.get("/:owner/:repo/wiki/*", (c) => wikiPage(c));
uiRouter.post("/:owner/:repo/wiki", (c) => wikiSubmit(c));
uiRouter.post("/:owner/:repo/wiki/*", (c) => wikiSubmit(c));
uiRouter.post("/:owner/:repo/settings", (c) => settingsSubmit(c));
uiRouter.get("/:owner/:repo/settings/hooks", (c) => hooksSettingsPage(c));
uiRouter.post("/:owner/:repo/settings/hooks", (c) => hooksSettingsSubmit(c));
// Wave-14 per-hook family (parseUiRoute claims exactly these shapes; the
// POSTs run the §2.8 sameOriginGuard first; the POST-only test/delete tails
// answer GET with chi's 405 — the comment/label write convention).
uiRouter.get("/:owner/:repo/settings/hooks/:id", (c) => hookDetailPage(c));
uiRouter.post("/:owner/:repo/settings/hooks/:id", (c) => hookDetailSubmit(c));
uiRouter.post("/:owner/:repo/settings/hooks/:id/test", (c) => hookTestSubmit(c));
uiRouter.get("/:owner/:repo/settings/hooks/:id/test", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/hooks/:id/delete", (c) => hookDeleteSubmit(c));
uiRouter.get("/:owner/:repo/settings/hooks/:id/delete", () => methodNotAllowed("POST"));
// Wave-10 mirror panel (parseUiRoute claims exactly this shape; the same
// settings gate as the other two sub-pages).
uiRouter.get("/:owner/:repo/settings/mirror", (c) => mirrorSettingsPage(c));
uiRouter.post("/:owner/:repo/settings/mirror", (c) => mirrorSyncSubmit(c));
// Wave-15 protected-branches family (parseUiRoute claims exactly these
// shapes — upstream's web.go:1206-1212 group; the POSTs run the §2.8
// sameOriginGuard first; the POST-only write tails answer GET with chi's
// 405 — the hook test/delete convention).
uiRouter.get("/:owner/:repo/settings/branches", (c) => branchProtectionListPage(c));
uiRouter.get("/:owner/:repo/settings/branches/edit", (c) => branchProtectionEditPage(c));
uiRouter.post("/:owner/:repo/settings/branches/edit", (c) => branchProtectionEditSubmit(c));
uiRouter.post("/:owner/:repo/settings/branches/priority", (c) => branchProtectionPrioritySubmit(c));
uiRouter.get("/:owner/:repo/settings/branches/priority", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/branches/:id/delete", (c) => branchProtectionDeleteSubmit(c));
uiRouter.get("/:owner/:repo/settings/branches/:id/delete", () => methodNotAllowed("POST"));
// Wave-16 branches family (parseUiRoute claims exactly these shapes —
// upstream's web.go:1478-1482 group; the delete POST runs the §2.8
// sameOriginGuard first and answers GET with chi's 405 — the hook
// test/delete convention).
uiRouter.get("/:owner/:repo/branches", (c) => branchesPage(c));
uiRouter.post("/:owner/:repo/branches/delete", (c) => branchDeleteSubmit(c));
uiRouter.get("/:owner/:repo/branches/delete", () => methodNotAllowed("POST"));
// Wave-29 diffpatch downloads (parseUiRoute claims exactly the dotted
// hex `{sha}.{diff|patch}` tail — upstream web.go:1760's RawDiff route).
// The narrow dotted pattern registers BEFORE the wave-18 broad :sha line so
// first-match-wins keeps the undotted shapes with the commit view (the
// pulls-pair registration note; `ABC.diff` misses the hex shape and lands
// in the commit view's 404-shell loader, upstream's pattern-miss answer).
uiRouter.get("/:owner/:repo/commit/:dpsha{[0-9a-f]{7,64}\\.(?:diff|patch)}", (c) => diffpatchFileDownload(c));
// Wave-18 commit-view family (parseUiRoute claims exactly the
// single-segment `{sha}` shape — upstream's web.go:1739 route; the
// ShortSha links every landed list page emits resolve from here).
uiRouter.get("/:owner/:repo/commit/:sha", (c) => commitViewPage(c));
// Wave-6 milestones families (parseUiRoute claims exactly these shapes; the
// static literal registers before any deeper dynamic tail could — there is
// none this slice, the shape is kept for the reasons above).
uiRouter.get("/:owner/:repo/milestones", (c) => milestonesPage(c));
uiRouter.get("/:owner/:repo/milestones/new", (c) => milestoneNewPage(c));
uiRouter.post("/:owner/:repo/milestones/new", (c) => milestoneNewSubmit(c));
// Wave-20 releases families (parseUiRoute claims exactly these shapes —
// upstream's web.go:1505-1514 group; the static literal tails register
// before the `/tag/*` catch-all so the precedence is local and obvious; the
// POST runs the §2.8 sameOriginGuard; the bare family carries GET only).
uiRouter.get("/:owner/:repo/releases", (c) => releasesPage(c));
uiRouter.get("/:owner/:repo/releases/new", (c) => releaseNewPage(c));
uiRouter.post("/:owner/:repo/releases/new", (c) => releaseNewSubmit(c));
uiRouter.get("/:owner/:repo/releases/latest", (c) => releaseLatestRedirect(c));
uiRouter.get("/:owner/:repo/releases/tag/*", (c) => releaseDetailPage(c));
// Wave-8 file editor families (parseUiRoute claims exactly these shapes; the
// POSTs run the §2.8 sameOriginGuard first — session.ts's convention; the
// `*` tail is the branch+path rest the handlers resolve against the branch
// universe). All three carry GET (the forms) + POST (the writes) — even the
// delete, whose confirmation page is where a failed CAS re-renders.
uiRouter.get("/:owner/:repo/new/*", (c) => fileEditorPage(c, "file-new"));
uiRouter.post("/:owner/:repo/new/*", (c) => fileEditorSubmit(c, "file-new"));
uiRouter.get("/:owner/:repo/edit/*", (c) => fileEditorPage(c, "file-edit"));
uiRouter.post("/:owner/:repo/edit/*", (c) => fileEditorSubmit(c, "file-edit"));
uiRouter.get("/:owner/:repo/delete/*", (c) => fileEditorPage(c, "file-delete"));
uiRouter.post("/:owner/:repo/delete/*", (c) => fileEditorSubmit(c, "file-delete"));
// Wave-6 single-segment family, wave-7-extended into the owner home (org
// rows → the org home, user rows → the user profile — upstream's
// OwnerProfile dispatch). The label regex is wave 6's VERBATIM (it already
// admits every name — user pages included — except TOP_LEVEL_EXCLUDED:
// /login + /logout are registered on the parent app AFTER this mount, so
// the dynamic shape would shadow them — verified Hono registration-order
// precedence; /healthz is the dispatcher's static route) so those requests
// miss this sub-app to their own routers. The parser stays the source of
// truth; the handler 404-shells any drift.
uiRouter.get("/:owner{^(?!login$|logout$|healthz$)[\\w.-]+$}", (c) => ownerHomePage(c));
// Wave-23 org families (parseUiRoute claims exactly these shapes —
// upstream's /org/{org}/members literal web.go:965 and the /{username}/-
// repositories route web.go:1134; appended at the physical tail because no
// registered pattern above can match them: the 3-segment shapes need a
// "members"/"repositories" tail no earlier family carries, the static
// "org"/"-" segments beat every dynamic peer, and the single-segment owner
// regex above is a different shape — so the tail registration keeps the
// sub-app's reach equal to the parser's, the drift guards absorbing any
// future collision loudly).
uiRouter.get("/org/:owner/members", (c) => orgMembersPage(c));
uiRouter.get("/:owner/-/repositories", (c) => orgRepositoriesPage(c));
// Wave-24 repo social lists (parseUiRoute claims exactly these shapes —
// upstream's web.go:1759/1766/1767 bare literals; GET-only read pages
// through the uiPage dispatch, the branches/releases convention).
uiRouter.get("/:owner/:repo/forks", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/stars", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/watchers", (c) => uiPage(c));
// Wave-24 collaboration panel (parseUiRoute claims exactly these shapes —
// upstream web.go:1194-1204's group; the POSTs run the §2.8 sameOriginGuard
// first and the four POST-only write tails answer GET with chi's 405 — the
// hook test/delete convention. No earlier registration can absorb these:
// /settings/collaboration/* is a deeper tail than every registered
// /settings family, and the static "collaboration" segment outranks any
// dynamic peer).
uiRouter.get("/:owner/:repo/settings/collaboration", (c) => collaborationPage(c));
uiRouter.post("/:owner/:repo/settings/collaboration", (c) => collaborationAddSubmit(c));
uiRouter.post("/:owner/:repo/settings/collaboration/access_mode", (c) => collaborationAccessModeSubmit(c));
uiRouter.get("/:owner/:repo/settings/collaboration/access_mode", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/collaboration/delete", (c) => collaborationDeleteSubmit(c));
uiRouter.get("/:owner/:repo/settings/collaboration/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/collaboration/team", (c) => collaborationTeamAddSubmit(c));
uiRouter.get("/:owner/:repo/settings/collaboration/team", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/collaboration/team/delete", (c) => collaborationTeamDeleteSubmit(c));
uiRouter.get("/:owner/:repo/settings/collaboration/team/delete", () => methodNotAllowed("POST"));
// Wave-25 repo tags + labels families (parseUiRoute claims exactly these
// shapes — upstream's web.go:1493-1496 `/tags` list literal and
// web.go:1338's labels page + web.go:1417-1422's three POST write segments).
// The tags page rides the uiPage dispatch (the social-trio convention); the
// labels POSTs run the §2.8 sameOriginGuard first and the three POST-only
// write tails answer GET with chi's 405 (the org-labels convention). No
// earlier registration can absorb these: the bare "tags"/"labels" tails are
// distinct single literals no registered pattern carries, and the org
// /:owner/labels pair (SECOND-segment literal) never matches a three-segment
// /:owner/:repo shape.
uiRouter.get("/:owner/:repo/tags", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/labels", (c) => repoLabelsPage(c));
uiRouter.post("/:owner/:repo/labels/new", (c) => repoLabelNewSubmit(c));
uiRouter.get("/:owner/:repo/labels/new", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/labels/edit", (c) => repoLabelEditSubmit(c));
uiRouter.get("/:owner/:repo/labels/edit", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/labels/delete", (c) => repoLabelDeleteSubmit(c));
uiRouter.get("/:owner/:repo/labels/delete", () => methodNotAllowed("POST"));
// Wave-45 repo projects (web.go:1544-1563 — pages/repo-projects.tsx): the
// literal list + the write group's /new combo + the numeric-{id} board,
// write and workflow shapes (chi static-before-dynamic — the literals
// register ahead of the params; the parser mirrors the order). The {repo}
// param carries the `[^-].*` constraint: a leading-dash segment is the
// owner namespace's (`/:owner/-/projects*`, the wave-37/40 families) and
// Hono must never route it here — the router-level twin of the parser's
// `repo === "-"` guard (upstream chi ranks the static `/-` group first; no
// landed slug starts with a dash, so the constraint claims nothing new).
// The PUT/DELETE/JSON board-helper arms stay unregistered, exactly upstream.
uiRouter.get("/:owner/:repo{[^-].*}/projects", (c) => repoProjectsPage(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/new", (c) => repoProjectNewPage(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/new", (c) => repoProjectNewSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id", (c) => repoProjectBoardPage(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/edit", (c) => repoProjectEditPage(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/edit", (c) => repoProjectEditSubmit(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/delete", (c) => repoProjectDeleteSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/open", (c) => repoProjectStatusSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/open", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/close", (c) => repoProjectStatusSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/close", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/columns/new", (c) => repoProjectColumnNewSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/columns/new", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/:columnId{\\d+}/default", (c) => repoProjectColumnDefaultSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/:columnId{\\d+}/default", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/workflows", (c) => repoProjectWorkflowsPage(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/workflows", (c) => repoProjectWorkflowCreateSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/workflows/:wid", (c) => repoProjectWorkflowsPage(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/workflows/:wid", (c) => repoProjectWorkflowUpdateSubmit(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/workflows/:wid/delete", (c) => repoProjectWorkflowDeleteSubmit(c));
// The GET 405 twin — upstream mounts addProjectWorkflowRoutes (POST-only
// delete tail) identically in BOTH groups (web.go:1140-1155 owner,
// 1544-1563 repo); the owner twin has carried this since 9b49cd2, the
// wave-45 repo block stopped at the POST line (the projects matrix's RED).
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/workflows/:wid/delete", () => methodNotAllowed("POST"));
// Wave-26 milestone detail + edit + fork form (parseUiRoute claims exactly
// these shapes — upstream web.go:1340's singular reader route,
// web.go:1427-1428's `{id}/edit` writer combo (the shared labels-write gate
// runs at the handlers) and web.go:1490's fork combo (the signed-in gate +
// the empty-source 404 run at the handlers; the POSTs run the §2.8
// sameOriginGuard first). No earlier registration can absorb these: the
// singular "milestone" head is a distinct literal, "new" under /milestones
// registered long before the dynamic :id tail (a 5-segment shape no earlier
// pattern carries), and the singular "fork" never collides with the landed
// bare "forks" literal.
uiRouter.get("/:owner/:repo/milestone/:id", (c) => milestoneDetailPage(c));
uiRouter.get("/:owner/:repo/milestones/:id/edit", (c) => milestoneEditPage(c));
uiRouter.post("/:owner/:repo/milestones/:id/edit", (c) => milestoneEditSubmit(c));
uiRouter.get("/:owner/:repo/fork", (c) => repoForkPage(c));
uiRouter.post("/:owner/:repo/fork", (c) => repoForkSubmit(c));
// Wave-32 archive download + commit aux JSON (parseUiRoute claims exactly
// these shapes — upstream web.go:1689's `/archive/*` wildcard, its bare URL
// included (the empty-tail 400 arm), and web.go:1740's
// `{sha}/load-branches-and-tags` 5-segment route). No earlier registration
// can absorb these: the "archive"/"load-branches-and-tags" literals are
// distinct tails no registered pattern carries, the 5-segment shape is
// deeper than every /commit family (the 4-segment :sha line cannot match
// it), and unclaimed shapes never reach the sub-app — the dispatcher
// consults handlesUiRoute first. GET only: the archive POST half
// (InitiateDownload) stays engine-owned.
uiRouter.get("/:owner/:repo/archive/*", (c) => archiveFileDownload(c));
uiRouter.get("/:owner/:repo/archive", (c) => archiveFileDownload(c));
uiRouter.get("/:owner/:repo/commit/:lbsha/load-branches-and-tags", (c) => commitContainedRefsJson(c));
// Wave-33 tags tails + releases edit/delete (parseUiRoute claims exactly
// these shapes — upstream's web.go:1499 `/tags/list` aux literal, web.go:1501
// `/tags/delete` POST, web.go:1519-1520 `/releases/edit/*` combo and
// web.go:1523 `/releases/delete` POST; the POSTs run the §2.8
// sameOriginGuard first and the POST-only tails answer GET with chi's 405 —
// the hook test/delete convention; the edit combo carries GET + POST). No
// earlier registration can absorb these: the "list"/"delete" tails under
// /tags and /releases are literals no registered pattern carries (the
// wave-20 /releases/tag/* catch-all matches only the "tag" head), the
// 5-segment /releases/edit/* shape is deeper than every 4-segment releases
// line, and unclaimed shapes never reach the sub-app — the dispatcher
// consults handlesUiRoute first.
uiRouter.get("/:owner/:repo/tags/list", (c) => tagListAuxJson(c));
uiRouter.post("/:owner/:repo/tags/delete", (c) => tagsDeleteSubmit(c));
uiRouter.get("/:owner/:repo/tags/delete", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo/releases/edit/*", (c) => releaseEditPage(c));
uiRouter.post("/:owner/:repo/releases/edit/*", (c) => releaseEditSubmit(c));
uiRouter.post("/:owner/:repo/releases/delete", (c) => releaseDeleteSubmit(c));
uiRouter.get("/:owner/:repo/releases/delete", () => methodNotAllowed("POST"));
// Wave-37 owner projects list (parseUiRoute claims exactly this shape —
// upstream web.go:1143's read group, `m.Get("", org.Projects)`; GET only,
// the board depth and the write group stay unclaimed per the page module's
// scoping note). Appended at the physical tail per the wave-23 convention:
// the static "-" segment outranks every dynamic peer and no registered
// pattern above carries a 4-segment /:owner/-/projects shape.
uiRouter.get("/:owner/-/projects", (c) => ownerProjectsPage(c));
// Wave-39 aux fragments + blob redirect (parseUiRoute claims exactly these
// shapes — upstream web.go:1757's `/blob/*` redirect wildcard + its bare
// literal (the dispatcher's 404-shell arm, the wave-2 /tree pair's posture),
// web.go:1297-1306's three typed `/tree-list/*` sub-routes, and
// web.go:1695's `/branches/list` aux literal; the JSON handlers run the
// resolveUiRequest prologue like every GET page). No earlier registration
// can absorb these: the "blob" and "tree-list" heads are literals no
// registered pattern carries (the wave-2 /tree pair matches only the "tree"
// head; the typed tail regex keeps the tree-list claim equal to the
// parser's), the branches "list" tail is a distinct literal beside wave-16's
// bare /branches + /branches/delete pair, and unclaimed shapes never reach
// the sub-app — the dispatcher consults handlesUiRoute first.
uiRouter.get("/:owner/:repo/blob/*", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/blob", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/tree-list/:tlref{branch|tag|commit}/*", (c) => treeListAuxJson(c));
// Wave-43 tree-view envelope (parseUiRoute claims exactly this shape —
// upstream web.go:1302-1306's three typed sub-routes, the tree-list twin's
// wildcard form; the JSON handler runs the resolveUiRequest prologue like
// every GET page). No earlier registration can absorb these: the "tree-view"
// head is a literal no registered pattern carries (the wave-2 /tree pair
// matches only the "tree" head; the typed tail regex keeps the claim equal
// to the parser's), and unclaimed shapes never reach the sub-app — the
// dispatcher consults handlesUiRoute first.
uiRouter.get("/:owner/:repo/tree-view/:tvref{branch|tag|commit}/*", (c) => treeViewAuxJson(c));
uiRouter.get("/:owner/:repo/branches/list", (c) => branchesListAuxJson(c));
// Wave-40 owner projects board + write group (parseUiRoute claims exactly
// these shapes — upstream web.go:1140-1155's board view/write group plus
// web.go:327-345's board/workflow helper POSTs; the POST-only tails answer
// GET with chi's 405 — the hook test/delete convention; the POSTs run the
// §2.8 sameOriginGuard first). No earlier registration can absorb these:
// the static "-" segment outranks every dynamic peer and no registered
// pattern above carries a ≥5-segment /:owner/-/projects/* shape; within the
// namespace the "new"
// literal outranks the dynamic {id} pattern by REGISTRATION ORDER too (the
// matcher's first-match answer decides the 5-segment collision — verified
// by the /new renders; chi gives static segments precedence).
uiRouter.get("/:owner/-/projects/new", (c) => ownerProjectNewPage(c));
uiRouter.post("/:owner/-/projects/new", (c) => ownerProjectNewSubmit(c));
uiRouter.get("/:owner/-/projects/:id", (c) => ownerProjectBoardPage(c));
uiRouter.get("/:owner/-/projects/:id/edit", (c) => ownerProjectEditPage(c));
uiRouter.post("/:owner/-/projects/:id/edit", (c) => ownerProjectEditSubmit(c));
uiRouter.post("/:owner/-/projects/:id/delete", (c) => ownerProjectDeleteSubmit(c));
uiRouter.get("/:owner/-/projects/:id/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/-/projects/:id/open", (c) => ownerProjectStatusSubmit(c));
uiRouter.get("/:owner/-/projects/:id/open", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/-/projects/:id/close", (c) => ownerProjectStatusSubmit(c));
uiRouter.get("/:owner/-/projects/:id/close", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/-/projects/:id/columns/new", (c) => ownerProjectColumnNewSubmit(c));
uiRouter.get("/:owner/-/projects/:id/columns/new", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/-/projects/:id/:columnId{\\d+}/default", (c) => ownerProjectColumnDefaultSubmit(c));
uiRouter.get("/:owner/-/projects/:id/:columnId{\\d+}/default", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/-/projects/:id/workflows", (c) => ownerProjectWorkflowsPage(c));
uiRouter.post("/:owner/-/projects/:id/workflows", (c) => ownerProjectWorkflowCreateSubmit(c));
uiRouter.get("/:owner/-/projects/:id/workflows/:wid", (c) => ownerProjectWorkflowsPage(c));
uiRouter.post("/:owner/-/projects/:id/workflows/:wid", (c) => ownerProjectWorkflowUpdateSubmit(c));
uiRouter.post("/:owner/-/projects/:id/workflows/:wid/delete", (c) => ownerProjectWorkflowDeleteSubmit(c));
uiRouter.get("/:owner/-/projects/:id/workflows/:wid/delete", () => methodNotAllowed("POST"));
// Wave-41 releases download tail + rendered blob views (parseUiRoute claims
// exactly these shapes — upstream web.go:1513's `/releases/attachments/{uuid}`
// + web.go:1514's `/releases/download/{vTag}/{fileName}` (both chi
// single-segment params, so the claims are the exact 3-/4-segment shapes) and
// web.go:1715-1719's `/render` group (the three typed sub-routes are the /src
// family's wildcard shape, the `/blob/{sha}` arm the exact 2-segment one);
// the JSON/binary handlers run the resolveUiRequest prologue like every GET
// page). No earlier registration can absorb these: the "download" and
// "attachments" literals under /releases match shapes the wave-20 lines do
// not carry (`/releases/tag/*` matches only the "tag" head), the "render"
// head is a literal no registered pattern carries, and unclaimed shapes
// never reach the sub-app — the dispatcher consults handlesUiRoute first.
uiRouter.get("/:owner/:repo/releases/attachments/:uuid", (c) => releaseDownloadTail(c));
uiRouter.get("/:owner/:repo/releases/download/:vtag/:filename", (c) => releaseDownloadTail(c));
uiRouter.get("/:owner/:repo/render/branch/*", (c) => renderFileView(c));
uiRouter.get("/:owner/:repo/render/tag/*", (c) => renderFileView(c));
uiRouter.get("/:owner/:repo/render/commit/*", (c) => renderFileView(c));
uiRouter.get("/:owner/:repo/render/blob/:sha", (c) => renderFileView(c));
// Wave-46 fragment mounts (parseUiRoute claims exactly these shapes — the
// machinery waves' routes: upstream web.go:1735's `/blob_excerpt/{sha}` repo
// twin + web.go:1618's wiki twin over repo.ExcerptBlob, and web.go:1761's
// `/lastcommit/*` wildcard (the bare URL included — chi's empty-tail match,
// the archive family's precedent; the default-branch arm 404-shells at the
// handler, the landed commit-arm convention). The HTML-fragment handlers run
// the resolveUiRequest prologue like every GET page. No earlier registration
// can absorb these: the "blob_excerpt", "wiki" and "lastcommit" heads are
// literals no registered pattern carries, the exact-shape params keep the
// claims equal to the parser's, and unclaimed shapes never reach the sub-app
// — the dispatcher consults handlesUiRoute first. The {repo} params stay
// PLAIN (no `[^-].*` constraint): the ae32b1a convention binds only when a
// static-second-segment `/-` twin exists (the projects families' case), and
// upstream's `/{username}/-` group (web.go:1107-1180) carries packages/
// mentions-in-owner/repositories/heatmap/projects ONLY — no blob_excerpt,
// no lastcommit, no wiki tail, so a leading-dash segment has no twin to
// shadow and the constraint would claim nothing (the /commits,/tags posture).
uiRouter.get("/:owner/:repo/blob_excerpt/:sha", (c) => blobExcerptFragment(c));
uiRouter.get("/:owner/:repo/wiki/blob_excerpt/:sha", (c) => blobExcerptFragment(c));
uiRouter.get("/:owner/:repo/lastcommit/*", (c) => lastCommitFragment(c));
