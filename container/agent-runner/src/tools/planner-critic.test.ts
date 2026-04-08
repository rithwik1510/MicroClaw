import { describe, it, expect } from 'vitest';
import {
  createPlannerCriticState,
  executeCreatePlan,
  executeCritiqueResponse,
  buildPlanProgressNote,
  updateStepProgress,
  resolveAdaptedBudgets,
  buildPlannerCriticTools,
} from './planner-critic.js';

const validPlan = {
  taskAnalysis: 'Multi-step research task requiring search and synthesis',
  steps: [
    {
      id: 1,
      action: 'Search for X',
      toolsNeeded: ['web_search'],
      dependsOn: [],
      successCriteria: 'Found key info about X',
    },
    {
      id: 2,
      action: 'Search for Y',
      toolsNeeded: ['web_search'],
      dependsOn: [],
      successCriteria: 'Found key info about Y',
    },
    {
      id: 3,
      action: 'Compare and synthesize',
      toolsNeeded: [],
      dependsOn: [1, 2],
      successCriteria: 'Clear comparison with recommendation',
    },
  ],
  expectedOutput: 'Structured comparison with actionable recommendation',
};

describe('create_plan', () => {
  it('accepts a valid plan with steps and returns formatted confirmation', () => {
    const state = createPlannerCriticState();
    const result = executeCreatePlan(validPlan, state);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('Plan accepted (3 steps)');
    expect(result.content).toContain('Step 1');
    expect(result.content).toContain('Begin with Step 1 now');
    expect(state.plan).not.toBeNull();
    expect(state.plan?.steps).toHaveLength(3);
    expect(state.plan?.steps[0].status).toBe('pending');
  });

  it('rejects plan with circular dependencies', () => {
    const state = createPlannerCriticState();
    const result = executeCreatePlan(
      {
        taskAnalysis: 'Cycle test',
        steps: [
          { id: 1, action: 'Step 1', dependsOn: [2] },
          { id: 2, action: 'Step 2', dependsOn: [1] },
        ],
      },
      state,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('cycle');
    expect(state.plan).toBeNull();
  });

  it('rejects plan with empty steps', () => {
    const state = createPlannerCriticState();
    const result = executeCreatePlan(
      { taskAnalysis: 'Empty steps test', steps: [] },
      state,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('empty');
    expect(state.plan).toBeNull();
  });

  it('rejects a second plan call', () => {
    const state = createPlannerCriticState();
    const first = executeCreatePlan(validPlan, state);
    expect(first.ok).toBe(true);
    const second = executeCreatePlan(validPlan, state);
    expect(second.ok).toBe(false);
    expect(second.content).toContain('already exists');
  });

  it('rejects plan missing taskAnalysis', () => {
    const state = createPlannerCriticState();
    const result = executeCreatePlan(
      { steps: [{ id: 1, action: 'Do something' }] },
      state,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('taskAnalysis');
  });

  it('rejects plan with a step missing action', () => {
    const state = createPlannerCriticState();
    const result = executeCreatePlan(
      {
        taskAnalysis: 'Test',
        steps: [{ id: 1, action: '' }],
      },
      state,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('missing an action');
  });
});

describe('critique_response', () => {
  it('returns pass message for complete quality', () => {
    const state = createPlannerCriticState();
    const result = executeCritiqueResponse(
      { quality_assessment: 'complete' },
      state,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('Deliver the final response');
    expect(state.critiqueCount).toBe(0);
  });

  it('returns revision prompt and increments count for needs_revision', () => {
    const state = createPlannerCriticState(2);
    const result = executeCritiqueResponse(
      {
        quality_assessment: 'needs_revision',
        issues: ['Missing pricing comparison'],
        revision_instructions: 'Add pricing data from search results',
      },
      state,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('Revision needed');
    expect(result.content).toContain('1 of 2');
    expect(result.content).toContain('Missing pricing comparison');
    expect(result.content).toContain('Add pricing data');
    expect(state.critiqueCount).toBe(1);
  });

  it('returns stop message when budget exhausted', () => {
    const state = createPlannerCriticState(1);
    executeCritiqueResponse({ quality_assessment: 'needs_revision' }, state);
    expect(state.critiqueCount).toBe(1);
    const result = executeCritiqueResponse(
      { quality_assessment: 'needs_revision' },
      state,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('budget exhausted');
    expect(state.critiqueCount).toBe(1); // didn't increment past max
  });

  it('returns deliver-with-gaps message for partial', () => {
    const state = createPlannerCriticState();
    const result = executeCritiqueResponse(
      {
        quality_assessment: 'partial',
        issues: ['Section 2 incomplete'],
      },
      state,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('partially complete');
    expect(result.content).toContain('Section 2 incomplete');
  });
});

describe('buildPlanProgressNote', () => {
  it('returns null when no plan', () => {
    const state = createPlannerCriticState();
    expect(buildPlanProgressNote(state)).toBeNull();
  });

  it('returns correct compact status with no active step', () => {
    const state = createPlannerCriticState();
    executeCreatePlan(validPlan, state);
    const note = buildPlanProgressNote(state);
    expect(note).toBe('[Plan: 0/3 done]');
  });

  it('returns correct compact status with completed and active steps', () => {
    const state = createPlannerCriticState();
    executeCreatePlan(validPlan, state);
    state.plan!.steps[0].status = 'completed';
    state.plan!.steps[1].status = 'in_progress';
    const note = buildPlanProgressNote(state);
    expect(note).toBe('[Plan: 1/3 done, step 2 active]');
  });
});

describe('updateStepProgress', () => {
  it('marks matching pending step as in_progress', () => {
    const state = createPlannerCriticState();
    executeCreatePlan(validPlan, state);
    updateStepProgress(state, 'web_search');
    expect(state.plan!.steps[0].status).toBe('in_progress');
    expect(state.plan!.steps[1].status).toBe('pending');
  });

  it('marks in_progress step as completed on second call', () => {
    const state = createPlannerCriticState();
    executeCreatePlan(validPlan, state);
    updateStepProgress(state, 'web_search');
    updateStepProgress(state, 'web_search');
    expect(state.plan!.steps[0].status).toBe('completed');
  });

  it('does nothing for unrelated tool names', () => {
    const state = createPlannerCriticState();
    executeCreatePlan(validPlan, state);
    updateStepProgress(state, 'browser_open_url');
    expect(state.plan!.steps[0].status).toBe('pending');
    expect(state.plan!.steps[1].status).toBe('pending');
  });
});

describe('resolveAdaptedBudgets', () => {
  it('returns current values when no plan active', () => {
    const state = createPlannerCriticState();
    const result = resolveAdaptedBudgets(state, 6, 90_000);
    expect(result.maxToolSteps).toBe(6);
    expect(result.toolLoopBudgetMs).toBe(90_000);
  });

  it('correctly scales steps and time budget', () => {
    const state = createPlannerCriticState();
    executeCreatePlan(validPlan, state); // 3 steps
    const result = resolveAdaptedBudgets(state, 6, 90_000);
    expect(result.maxToolSteps).toBe(10); // max(6, 3*2+4=10)
    expect(result.toolLoopBudgetMs).toBe(90_000); // max(90000, 3*20000=60000)
  });

  it('scales time budget when plan is bigger than default', () => {
    const state = createPlannerCriticState();
    executeCreatePlan(validPlan, state); // 3 steps
    const result = resolveAdaptedBudgets(state, 6, 30_000);
    expect(result.toolLoopBudgetMs).toBe(60_000); // max(30000, 3*20000=60000)
  });

  it('respects cap of 24 steps', () => {
    const state = createPlannerCriticState();
    const bigPlan = {
      taskAnalysis: 'Big task',
      steps: Array.from({ length: 12 }, (_, i) => ({
        id: i + 1,
        action: `Step ${i + 1}`,
        toolsNeeded: [],
        dependsOn: [],
        successCriteria: '',
      })),
      expectedOutput: 'Big result',
    };
    executeCreatePlan(bigPlan, state);
    const result = resolveAdaptedBudgets(state, 6, 90_000);
    expect(result.maxToolSteps).toBe(24); // min(24, 12*2+4=28)
  });
});

describe('buildPlannerCriticTools', () => {
  it('produces 2 tools with correct names and families', () => {
    const state = createPlannerCriticState();
    const tools = buildPlannerCriticTools(state);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('create_plan');
    expect(tools[0].family).toBe('meta');
    expect(tools[1].name).toBe('critique_response');
    expect(tools[1].family).toBe('meta');
  });

  it('tools share state — create_plan result visible in critique_response', async () => {
    const state = createPlannerCriticState();
    const tools = buildPlannerCriticTools(state);
    const createTool = tools[0];
    const critiqueTool = tools[1];

    const fakeCtx = {} as never;
    await createTool.execute(validPlan, fakeCtx);
    expect(state.plan).not.toBeNull();

    const critiqueResult = await critiqueTool.execute(
      { quality_assessment: 'complete' },
      fakeCtx,
    );
    expect(critiqueResult.content).toContain('Deliver the final response');
  });
});
