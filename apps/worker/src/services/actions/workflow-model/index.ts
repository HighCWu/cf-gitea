// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The workflow-model barrel — SPEC-0012 §D5 tier E, the E5 YAML workflow
// model: actionslib v1.5.0 pkg/model's matrix expansion plus the submodule's
// jobparser Job/Strategy decode, Strategy.resolve, buildMatrixCombos and
// ExpandMatrixWithNeeds (the §D5 staged block's exact symbol list).

export * from "./yaml-nodes";
export * from "./matrix";
export * from "./job";
export * from "./combos";
