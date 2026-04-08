import { ToolExecutionContext, ToolExecutionResult, ToolHandler } from './types.js';

// --- Types ---

interface PlanStep {
  id: number;
  action: string;
  toolsNeeded: string[];
  dependsOn: number[];
  successCriteria: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
}

interface ExecutionPlan {
  taskAnalysis: string;
  steps: PlanStep[];
  expectedOutput: string;
  createdAt: number;
}

export interface PlannerCriticState {
  plan: ExecutionPlan | null;
  critiqueCount: number;
  maxRevisions: number;
}

// --- Helpers ---

function hasCyclicDependencies(steps: PlanStep[]): boolean {
  const idSet = new Set(steps.map((s) => s.id));
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set<number>();
  const recStack = new Set<number>();

  function dfs(id: number): boolean {
    visited.add(id);
    recStack.add(id);
    const step = stepMap.get(id);
    if (!step) return false;
    for (const dep of step.dependsOn) {
      if (!idSet.has(dep)) continue;
      if (!visited.has(dep)) {
        if (dfs(dep)) return true;
      } else if (recStack.has(dep)) {
        return true;
      }
    }
    recStack.delete(id);
    return false;
  }

  for (const step of steps) {
    if (!visited.has(step.id)) {
      if (dfs(step.id)) return true;
    }
  }
  return false;
}

// --- Public API ---

export function createPlannerCriticState(maxRevisions = 2): PlannerCriticState {
  return { plan: null, critiqueCount: 0, maxRevisions };
}

export function executeCreatePlan(
  args: Record<string, unknown>,
  state: PlannerCriticState,
): ToolExecutionResult {
  if (state.plan !== null) {
    return {
      ok: false,
      content:
        'A plan already exists for this run. You can only create one plan per turn. Follow the existing plan.',
    };
  }

  const taskAnalysis =
    typeof args.taskAnalysis === 'string' ? args.taskAnalysis.trim() : '';
  const expectedOutput =
    typeof args.expectedOutput === 'string' ? args.expectedOutput.trim() : '';
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];

  if (!taskAnalysis) {
    return { ok: false, content: 'Plan rejected: taskAnalysis is required.' };
  }

  if (rawSteps.length === 0) {
    return {
      ok: false,
      content: 'Plan rejected: steps array must not be empty.',
    };
  }

  const steps: PlanStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i] as Record<string, unknown>;
    const id = typeof raw.id === 'number' ? raw.id : i + 1;
    const action = typeof raw.action === 'string' ? raw.action.trim() : '';
    if (!action) {
      return {
        ok: false,
        content: `Plan rejected: step ${id} is missing an action.`,
      };
    }
    steps.push({
      id,
      action,
      toolsNeeded: Array.isArray(raw.toolsNeeded)
        ? (raw.toolsNeeded as unknown[]).map(String)
        : [],
      dependsOn: Array.isArray(raw.dependsOn)
        ? (raw.dependsOn as unknown[]).map(Number)
        : [],
      successCriteria:
        typeof raw.successCriteria === 'string' ? raw.successCriteria : '',
      status: 'pending',
    });
  }

  if (hasCyclicDependencies(steps)) {
    return {
      ok: false,
      content:
        'Plan rejected: dependency graph contains a cycle. Fix dependsOn so all steps flow in one direction.',
    };
  }

  state.plan = { taskAnalysis, steps, expectedOutput, createdAt: Date.now() };

  const stepList = steps
    .map(
      (s) =>
        `  Step ${s.id}: ${s.action}${s.toolsNeeded.length ? ` [tools: ${s.toolsNeeded.join(', ')}]` : ''}`,
    )
    .join('\n');

  return {
    ok: true,
    content: `Plan accepted (${steps.length} step${steps.length !== 1 ? 's' : ''}).\n${stepList}\n\nBegin with Step ${steps[0].id} now.`,
  };
}

export function executeCritiqueResponse(
  args: Record<string, unknown>,
  state: PlannerCriticState,
): ToolExecutionResult {
  const quality =
    typeof args.quality_assessment === 'string'
      ? args.quality_assessment.toLowerCase()
      : 'complete';
  const issues = Array.isArray(args.issues)
    ? (args.issues as unknown[]).map(String)
    : [];
  const revisionInstructions =
    typeof args.revision_instructions === 'string'
      ? args.revision_instructions.trim()
      : '';

  if (quality === 'complete') {
    return {
      ok: true,
      content: 'Critique passed. Deliver the final response now.',
    };
  }

  if (quality === 'partial') {
    const gapNote =
      issues.length > 0 ? ` Noted gaps: ${issues.join('; ')}.` : '';
    return {
      ok: true,
      content: `Response is partially complete.${gapNote} Deliver the response now with a brief note about what was not covered.`,
    };
  }

  // needs_revision
  const budget = state.maxRevisions - state.critiqueCount;
  if (budget <= 0) {
    return {
      ok: true,
      content: `Revision budget exhausted (${state.maxRevisions} of ${state.maxRevisions} used). Deliver the best available response now without further changes.`,
    };
  }

  state.critiqueCount++;
  const remaining = state.maxRevisions - state.critiqueCount;
  const issueNote = issues.length > 0 ? `\nIssues: ${issues.join('; ')}` : '';
  const instructionNote = revisionInstructions
    ? `\nFix: ${revisionInstructions}`
    : '';

  return {
    ok: true,
    content: `Revision needed (${state.critiqueCount} of ${state.maxRevisions} allowed).${issueNote}${instructionNote}\n\nRevise your response${remaining > 0 ? ', then call critique_response again' : ' and deliver the final result'}.`,
  };
}

/** Returns compact progress string or null if no plan active. */
export function buildPlanProgressNote(state: PlannerCriticState): string | null {
  if (!state.plan) return null;
  const total = state.plan.steps.length;
  const completed = state.plan.steps.filter((s) => s.status === 'completed').length;
  const active = state.plan.steps.find((s) => s.status === 'in_progress');
  const activeNote = active ? `, step ${active.id} active` : '';
  return `[Plan: ${completed}/${total} done${activeNote}]`;
}

/** Updates step status based on which tool was just executed. */
export function updateStepProgress(
  state: PlannerCriticState,
  toolName: string,
): void {
  if (!state.plan) return;
  for (const step of state.plan.steps) {
    if (step.status !== 'pending' && step.status !== 'in_progress') continue;
    if (!step.toolsNeeded.includes(toolName)) continue;
    if (step.status === 'pending') {
      step.status = 'in_progress';
    } else {
      step.status = 'completed';
    }
    break;
  }
  // Flush in_progress steps with no tools needed
  for (const step of state.plan.steps) {
    if (step.status === 'in_progress' && step.toolsNeeded.length === 0) {
      step.status = 'completed';
    }
  }
}

/** Returns adapted budgets when a plan is active. */
export function resolveAdaptedBudgets(
  state: PlannerCriticState,
  currentMaxSteps: number,
  currentLoopBudgetMs: number,
): { maxToolSteps: number; toolLoopBudgetMs: number } {
  if (!state.plan) {
    return { maxToolSteps: currentMaxSteps, toolLoopBudgetMs: currentLoopBudgetMs };
  }
  const stepCount = state.plan.steps.length;
  const maxToolSteps = Math.min(24, Math.max(currentMaxSteps, stepCount * 2 + 4));
  const toolLoopBudgetMs = Math.max(currentLoopBudgetMs, stepCount * 20_000);
  return { maxToolSteps, toolLoopBudgetMs };
}

/** Factory — returns two ToolHandlers bound to state. */
export function buildPlannerCriticTools(state: PlannerCriticState): ToolHandler[] {
  return [
    {
      name: 'create_plan',
      family: 'meta',
      description:
        'Create a step-by-step execution plan before tackling a complex task. Use this when the request involves multiple steps, needs research + synthesis, has sequential dependencies, or would benefit from structured thinking before acting. Do NOT use for simple greetings, single-fact answers, or brief conversational replies.',
      schema: {
        type: 'object',
        properties: {
          taskAnalysis: {
            type: 'string',
            description: 'Brief analysis of the task and why a plan is needed.',
          },
          steps: {
            type: 'array',
            description: 'Ordered list of steps to complete the task.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'Unique step ID (1-based).' },
                action: { type: 'string', description: 'What to do in this step.' },
                toolsNeeded: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Tool names this step will invoke.',
                },
                dependsOn: {
                  type: 'array',
                  items: { type: 'number' },
                  description: 'Step IDs that must complete before this step.',
                },
                successCriteria: {
                  type: 'string',
                  description: 'How to know this step is complete.',
                },
              },
              required: ['id', 'action'],
              additionalProperties: false,
            },
          },
          expectedOutput: {
            type: 'string',
            description: 'What the final response should contain.',
          },
        },
        required: ['taskAnalysis', 'steps'],
        additionalProperties: false,
      },
      execute: async (
        args: Record<string, unknown>,
        _ctx: ToolExecutionContext,
      ): Promise<ToolExecutionResult> => executeCreatePlan(args, state),
    },
    {
      name: 'critique_response',
      family: 'meta',
      description:
        'Evaluate the quality and completeness of your response before delivering it to the user. Use this after completing a planned task. Checks whether all plan steps were addressed and the response fully answers the original request. If issues are found, provides specific revision instructions.',
      schema: {
        type: 'object',
        properties: {
          quality_assessment: {
            type: 'string',
            enum: ['complete', 'needs_revision', 'partial'],
            description: 'Overall quality of the prepared response.',
          },
          plan_steps_completed: {
            type: 'array',
            items: { type: 'number' },
            description: 'IDs of plan steps that are fully addressed.',
          },
          issues: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Specific issues found in the response (if needs_revision or partial).',
          },
          revision_instructions: {
            type: 'string',
            description:
              'Concrete instructions for what to fix (if needs_revision).',
          },
        },
        required: ['quality_assessment'],
        additionalProperties: false,
      },
      execute: async (
        args: Record<string, unknown>,
        _ctx: ToolExecutionContext,
      ): Promise<ToolExecutionResult> => executeCritiqueResponse(args, state),
    },
  ];
}
