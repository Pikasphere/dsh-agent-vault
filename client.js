/**
 * Agent memory and knowledge — browser half.
 *
 * One sidebar panel (`agent-memory`) that opens the manager page in the main
 * column. Data comes from the plugin's own same-origin `/api/agent-memory`
 * routes, so the page works in every Web composition instead of depending on a
 * typed Remote binding.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides.
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    /** Sidebar → panel commands: "+" opens the panel's create form. */
    const sidebarBridge = { createAgent: false, onRequestCreateAgent: null }

    const NS = 'agentMemory'

    // ── copy ────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '智能体',
        title: '智能体',
        subtitle: '每个智能体一段可继承的记忆；知识库由所有智能体共享。',
        agents: '智能体列表',
        create: '新建',
        createTitle: '新建智能体',
        name: '名称',
        namePlaceholder: '例如：重构助手',
        desc: '说明',
        descPlaceholder: '这个智能体负责什么（可选）',
        cancel: '取消',
        confirm: '创建',
        emptyList: '还没有智能体。新建一个开始。',
        emptyPick: '从左侧选择一个智能体，或新建一个。',
        memory: '记忆',
        knowledge: '知识库',
        settings: '设置',
        memoryHint:
          '记忆由智能体在任务完成或交接时写入，只保留下一次必须知道的东西。它不会自动进入会话——是否读入、读入哪一个，由你决定。',
        memoryPlaceholder: '这个智能体上次做到哪里、决定了什么、下一步是什么……',
        chars: '字',
        overLimit: '超出上限，请精简记忆。',
        save: '保存记忆',
        saved: '已保存',
        inherit: '默认智能体',
        inheritHint: '新开的对话没有单独指定智能体时用它；每个对话自己的选择优先。',
        binding: '智能体',
        noAgent: '不指定',
        boundTo: '已绑定 {n} 个对话',
        active: '默认',
        memoryMeta: '记忆更新于',
        never: '尚未写入',
        kbTitle: '共享知识库',
        kbEmpty: '共享知识库还是空的。任何智能体工作时都会往里写，你也可以手动添加。',
        kbHint: '这里由所有智能体共享：谁写进去的经验，其他智能体都能检索到；每条会标出贡献者。',
        shared: '共享',
        contributor: '贡献者',
        allAgents: '全部',
        newEntry: '新建条目',
        searchPlaceholder: '搜索标题、标签、内容…',
        search: '搜索',
        clear: '清空',
        entryTitle: '标题',
        entryTags: '标签（逗号分隔）',
        entryBody: '内容（Markdown）',
        saveEntry: '保存条目',
        deleteEntry: '删除条目',
        back: '返回列表',
        edit: '编辑',
        del: '删除',
        updatedAt: '更新于',
        entryCount: '条',
        noResult: '没有匹配的条目。',
        dirTitle: '知识库目录',
        dirHint:
          '所有智能体共用这一个目录，条目直接放在目录下（不再按智能体分文件夹）。改完立即生效，旧的按智能体分文件夹的内容会自动合并进来。',
        dirPlaceholder: '例如 D:\\notes\\agent-knowledge',
        dirSave: '保存目录',
        dirDefault: '默认目录',
        dirConfigured: '自定义目录',
        vaultMeta: '记忆 {m}/{limit} 字 · 贡献 {k} 条 · 用于 {u} 个对话',
        deleteVault: '删除智能体',
        deleteVaultHint: '只删除这个智能体的记忆；共享知识库里它贡献的条目会保留。',
        deleteVaultConfirm: '删除智能体「{name}」？',
        busy: '处理中…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        noticeSaved: '已保存',
        danger: '危险操作',
        descLabel: '说明',
        rename: '保存名称',
        usageTitle: '正在使用它的对话',
        usageEmpty: '还没有对话使用它。新建对话时可以在顶部那一行选择。',
        usageUnbind: '解除绑定',
        usageTag: '对话',
        untitled: '未命名对话',
        rooms: '讨论室',
        journal: '日志',
        roomsEmpty: '还没有讨论室。新建一个，再点下面的成员名字把智能体加进来。',
        roomName: '讨论室名称',
        roomNamePlaceholder: '例如：架构评审',
        roomMembers: '成员（点击加入 / 移出）',
        roomEmpty: '还没有发言。',
        roomPlaceholder: '以你的身份说一句…（Enter 发送，Shift+Enter 换行）',
        deleteRoom: '删除讨论室',
        send: '发送',
        membersUnit: '人',
        messagesUnit: '条消息',
        journalHint: '私有日志：只属于这个智能体的详细记录（类似日记）。其他智能体看不到，也不会自动注入，它自己决定何时查阅。',
        journalEmpty: '这个智能体还没有写日志。',
        journalReadOnly: '日志是追加式的，已有条目只读；要补充就新建一条。',
        handoff: '接力',
        handoffHint: '上下文压力到达阈值后，这一步会提醒模型先写记忆和日志；两件都完成后自动生成一份交棒检查点，存进该智能体的日志（可选再导出一份 markdown）。',
        handoffEnabled: '启用接力提醒',
        handoffEnabledHint: '关闭后不再测量压力，也不生成检查点。',
        handoffThreshold: '触发的 token 阈值',
        handoffRemindEvery: '提醒间隔（步）',
        handoffExport: '导出目录（可选）',
        handoffExportPlaceholder: '留空则只写入日志',
        handoffExportHint: '填了就额外写一份 markdown 到该目录；日志始终是唯一真相。',
        handoffSessions: '当前会话压力',
        handoffNoSessions: '当前没有活动会话。',
        autoSwitch: '检查点后自动开启新对话',
        autoSwitchHint: '当前会话写下检查点、且这个回合结束后，自动新建一个对话并切过去（继承绑定、工作区、审批策略与模型），旧会话转为归档。需要面板保持打开或页面在运行。',
        autoStartPrompt: '启动指令',
        autoStartPromptPlaceholder: '新对话打开后自动发送的第一条消息…',
        autoStartPromptHint: '自动切换创建新对话后，把这段文字作为第一条消息发出去；留空则只打开对话、不发消息。手动「续会话」不会发送。',
        'stage.off': '已关闭',
        'stage.watching': '观察中',
        'stage.due': '已到阈值',
        'stage.requested': '等待沉淀',
        'stage.settled': '已生成检查点',
        handoffSave: '保存设置',
        handoffReset: '重置',
        handoffResetConfirm: '重置这个会话的接力状态？它会重新从“观察中”开始；已生成的检查点日志不会删除。',
        handoffCheckpoint: '检查点',
        handoffExported: '已导出',
        handoffContinue: '续会话',
        handoffContinueHint: '新建一个会话：自动绑定这个智能体，并继承当前的审批策略。',
        handoffNoWorkspace: '当前环境不支持从面板新建会话。',
        handoffArmed: '待续',
        handoffArmedHint: '30 分钟内在这个目录新建的会话会自动绑定该智能体，并继承审批策略。',
        sessionsTab: '对话',
        sessionsHint: '这里按智能体收拢它的对话。已绑定的对话会从左侧工作区列表里隐藏，只能从这里或搜索找到；选择工作区会立即切过去。',
        sessionsTitle: '它的对话',
        sessionsEmpty: '这个智能体还没有对话。选一个工作区，点「新建对话」开始。',
        sessionsWorkspace: '工作区',
        sessionsNew: '新建对话',
        sessionsOpen: '打开',
        sessionsNoWorkspace: '未分组',
        sessionsGone: '记录已不存在',
        running: '运行中',
        hideBound: '已绑定对话不在工作区显示',
        hideBoundHint: '绑定到智能体的对话从左侧工作区列表里隐藏；在本页签按智能体查找和打开。',
        sidebarAgents: '智能体对话',
        sidebarCollapse: '收起',
        sidebarExpand: '展开',
        sidebarPanel: '打开智能体面板',
        sideArchived: '只读',
        sideRunning: '运行中',
        sideView: '视图选项',
        sideAddAgent: '添加智能体',
        sideSearch: '搜索智能体或对话',
        sideClose: '关闭搜索',
        sideSearchEmpty: '没有匹配的对话',
        sideSort: '排序',
        sideSortRecent: '最近活动',
        sideSortName: '按名称',
        sideShow: '显示',
        sideShowArchived: '显示归档对话',
        sideGroup: '分组',
        sideCollapseAll: '全部收起',
        sideExpandAll: '全部展开',
        archiveWeak: '归档',
        archiveStrong: '强归档',
        archiveCancel: '取消归档',
        archiveToStrong: '转为强归档',
        archiveToWeak: '转回归档',
        archiveDo: '归档',
        archiveWeakHint: '已归档：可以查看历史，但发送会被拒绝；可以取消归档或转为强归档。',
        archiveStrongHint: '强归档：彻底隐藏，侧栏不显示、列表灰色、不能打开；可以转回普通归档。',
        archiveBanner: '该对话已归档（只读）：发送会被拒绝',
        archiveDoHint: '归档为只读，可以随时取消。',
        ctxOpen: '打开',
        ctxArchive: '归档',
        ctxArchiveHint: '只读：可读历史，发送被拒绝',
        ctxToStrong: '转化为强归档',
        ctxToStrongHint: '从侧栏隐藏，面板灰显',
        ctxUnarchive: '取消归档',
        ctxUnarchiveHint: '恢复为普通对话',
        ctxNewSession: '在智能体名下创建新对话',
        ctxNewSessionHint: '新建并自动绑定这个智能体',
        ctxCollapse: '收起该智能体',
        ctxExpand: '展开该智能体',
        ctxSelected: '已选',
        ctxUnit: '个对话',
        ctxDoneArchive: '已归档',
        ctxDoneStrong: '已强归档',
        ctxDoneUnarchive: '已取消归档',
        ctxDoneNew: '已新建对话并绑定',
        ctxFailed: '操作失败',
        ctxTip: '右键对话可归档、强归档、取消归档或新建对话；Ctrl / Shift 点击可多选',
        recall: '回忆',
        recallHint: '在当前智能体的日志、记忆审计和共享知识库里按词检索。只查索引，不进提示词，不额外消耗 token。',
        recallPlaceholder: '找什么？一句话或几个关键词',
        recallSearch: '检索',
        recallClear: '清空',
        recallEmpty: '还没检索。先写几个关键词。',
        recallNoResult: '没有命中。换个说法，或放宽来源与日期。',
        recallUnit: '条命中',
        recallAll: '全部来源',
        recallSince: '起始日期',
        recallExpandSoon: '带「关联·」徽标的结果是沿引用、共享实体或同一会话扩出来的一跳邻居；展开项里写着它关联自什么。',
        recallIndex: '索引状态',
        recallIndexTotal: '条目',
        recallBuilt: '构建于',
        recallRebuild: '重建索引',
        recallRebuilt: '索引已重建',
        recallSrcJournal: '日志',
        recallSrcLog: '记忆',
        recallSrcKnowledge: '知识库',
        transcripts: '对话入索引',
        transcriptsHint: '把本智能体交接过的会话（以及绑定到它的会话）里的用户与助手文本编进索引，供「回忆」检索；工具输出与推理过程不入库，密钥会被打码，每个会话最多 12000 字。改动需重启宿主才彻底生效。',
        recallSrcSession: '对话',
        recallGoSession: '回到对话',
        recallOpen: '展开全文',
        recallClose: '收起',
        recallScore: '得分',
        recallViaAlias: '关联·别名',
        recallViaRef: '关联·引用',
        recallViaEntity: '关联·实体',
        recallViaSession: '关联·会话',
        recallWhy: '关联自',
      },
      en: {
        nav: 'Agents',
        title: 'Agents',
        subtitle: 'One inheritable memory per agent; one knowledge base shared by all of them.',
        agents: 'Agents',
        create: 'New',
        createTitle: 'New agent',
        name: 'Name',
        namePlaceholder: 'e.g. Refactor assistant',
        desc: 'Description',
        descPlaceholder: 'What this agent is for (optional)',
        cancel: 'Cancel',
        confirm: 'Create',
        emptyList: 'No agents yet. Create one to start.',
        emptyPick: 'Pick an agent on the left, or create one.',
        memory: 'Memory',
        knowledge: 'Knowledge',
        settings: 'Settings',
        memoryHint:
          'The agent writes this when a task ends or work is handed off. It keeps only what the next run must know. It never enters a session by itself — you choose whether to load it, and which one.',
        memoryPlaceholder: 'Where the agent got to, what it decided, what comes next…',
        chars: 'chars',
        overLimit: 'Over the limit — trim the memory.',
        save: 'Save memory',
        saved: 'Saved',
        inherit: 'Default agent',
        inheritHint: 'Used by a new conversation that has not picked an agent itself; a per-conversation choice wins.',
        binding: 'Agent',
        noAgent: 'None',
        boundTo: 'bound to {n} conversations',
        active: 'Default',
        memoryMeta: 'Memory updated',
        never: 'never written',
        kbTitle: 'Shared knowledge base',
        kbEmpty: 'The shared library is empty. Every agent writes here as it works; you can add entries too.',
        kbHint: 'Shared by every agent: anything one agent records is searchable by the others, and each entry names its contributor.',
        shared: 'shared',
        contributor: 'by',
        allAgents: 'All',
        newEntry: 'New entry',
        searchPlaceholder: 'Search title, tags, content…',
        search: 'Search',
        clear: 'Clear',
        entryTitle: 'Title',
        entryTags: 'Tags (comma separated)',
        entryBody: 'Content (Markdown)',
        saveEntry: 'Save entry',
        deleteEntry: 'Delete entry',
        back: 'Back to list',
        edit: 'Edit',
        del: 'Delete',
        updatedAt: 'updated',
        entryCount: 'entries',
        noResult: 'No matching entries.',
        dirTitle: 'Knowledge directory',
        dirHint:
          'Every agent shares this one directory; entries sit directly in it instead of per-agent folders. Changes apply immediately, and any older per-agent folders are folded in automatically.',
        dirPlaceholder: 'e.g. D:\\notes\\agent-knowledge',
        dirSave: 'Save directory',
        dirDefault: 'Default directory',
        dirConfigured: 'Custom directory',
        vaultMeta: 'memory {m}/{limit} · contributed {k} · used by {u}',
        deleteVault: 'Delete agent',
        deleteVaultHint: 'Removes this agent’s memory only; entries it contributed stay in the shared library.',
        deleteVaultConfirm: 'Delete agent “{name}”?',
        busy: 'Working…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        noticeSaved: 'Saved',
        danger: 'Danger zone',
        descLabel: 'Description',
        rename: 'Save name',
        usageTitle: 'Conversations using it',
        usageEmpty: 'No conversation uses it yet. Pick one in the New Session row.',
        usageUnbind: 'Unbind',
        usageTag: 'session',
        untitled: 'Untitled conversation',
        rooms: 'Rooms',
        journal: 'Journal',
        roomsEmpty: 'No rooms yet. Create one, then click member names to add agents.',
        roomName: 'Room name',
        roomNamePlaceholder: 'e.g. Architecture review',
        roomMembers: 'Members (click to add / remove)',
        roomEmpty: 'No messages yet.',
        roomPlaceholder: 'Say something as yourself… (Enter sends, Shift+Enter adds a line)',
        deleteRoom: 'Delete room',
        send: 'Send',
        membersUnit: 'members',
        messagesUnit: 'messages',
        journalHint: 'Private journal: the detailed diary-like record of this one agent. Other agents cannot see it, nothing is injected automatically, and the agent decides when to consult it.',
        journalEmpty: 'This agent has not written a journal entry yet.',
        journalReadOnly: 'The journal is append-only, so an existing entry is read-only; add a new one instead.',
        handoff: 'Handoff',
        handoffHint: 'When context pressure reaches the threshold, this step asks the model to write its memory and journal first; once both land, a handoff checkpoint is written into that agent journal (optionally exported as markdown).',
        handoffEnabled: 'Enable handoff reminders',
        handoffEnabledHint: 'When off, pressure is not measured and no checkpoint is produced.',
        handoffThreshold: 'Trigger threshold (tokens)',
        handoffRemindEvery: 'Remind every N steps',
        handoffExport: 'Export directory (optional)',
        handoffExportPlaceholder: 'Empty: journal only',
        handoffExportHint: 'When set, a markdown copy is written there too; the journal stays the source of truth.',
        handoffSessions: 'Current session pressure',
        handoffNoSessions: 'No live sessions right now.',
        autoSwitch: 'Start a new conversation after a checkpoint',
        autoSwitchHint: 'Once the current session has a checkpoint and its turn is over, a fresh conversation opens automatically in the same workspace with the inherited agent, approval policy and model; the old one is archived.',
        autoStartPrompt: 'Startup instruction',
        autoStartPromptPlaceholder: 'First message sent into the new conversation…',
        autoStartPromptHint: 'After the automatic switch creates the new conversation, this text is sent as its first message. Leave it empty to open the conversation without sending anything. Manual "Continue in new session" never sends it.',
        'stage.off': 'off',
        'stage.watching': 'watching',
        'stage.due': 'at threshold',
        'stage.requested': 'awaiting checkpoint',
        'stage.settled': 'checkpoint written',
        handoffSave: 'Save settings',
        handoffReset: 'Reset',
        handoffResetConfirm: 'Reset this session’s handoff state? It restarts from "watching"; checkpoints already written to the journal are kept.',
        handoffCheckpoint: 'checkpoint',
        handoffExported: 'exported',
        handoffContinue: 'Continue in new session',
        handoffContinueHint: 'Start a fresh session bound to this agent and carrying over its approval policy.',
        handoffNoWorkspace: 'This environment cannot start a session from the panel.',
        handoffArmed: 'ready to continue',
        handoffArmedHint: 'A new session in this directory within 30 minutes will inherit this agent and its approval policy.',
        sessionsTab: 'Sessions',
        sessionsHint: 'Each agent keeps its own conversations here. Bound conversations are hidden from the workspace list on the left; find them here or through search. Picking a workspace switches to it right away.',
        sessionsTitle: 'Its conversations',
        sessionsEmpty: 'This agent has no conversation yet. Pick a workspace and press New conversation.',
        sessionsWorkspace: 'Workspace',
        sessionsNew: 'New conversation',
        sessionsOpen: 'Open',
        sessionsNoWorkspace: 'unassigned',
        sessionsGone: 'log missing',
        running: 'running',
        hideBound: 'Hide bound conversations from workspaces',
        hideBoundHint: 'Conversations bound to an agent are hidden in the workspace list and found here, per agent.',
        sidebarAgents: 'Agent conversations',
        sidebarCollapse: 'Collapse',
        sidebarExpand: 'Expand',
        sidebarPanel: 'Open the Agents panel',
        sideArchived: 'read-only',
        sideRunning: 'running',
        sideView: 'View options',
        sideAddAgent: 'Add agent',
        sideSearch: 'Search agents or conversations',
        sideClose: 'Close search',
        sideSearchEmpty: 'No matching conversations',
        sideSort: 'Sort',
        sideSortRecent: 'Recent activity',
        sideSortName: 'Name',
        sideShow: 'Show',
        sideShowArchived: 'Archived conversations',
        sideGroup: 'Groups',
        sideCollapseAll: 'Collapse all',
        sideExpandAll: 'Expand all',
        archiveWeak: 'archived',
        archiveStrong: 'strong archive',
        archiveCancel: 'Cancel archive',
        archiveToStrong: 'Make strong',
        archiveToWeak: 'Back to archived',
        archiveDo: 'Archive',
        archiveWeakHint: 'Archived: history stays readable, but sending is rejected. Cancel it or promote it to strong.',
        archiveStrongHint: 'Strong archive: fully hidden — grey here, absent from the sidebar, cannot open. Can be turned back to a normal archive.',
        archiveBanner: 'This conversation is archived (read-only): sending is blocked',
        archiveDoHint: 'Archive as read-only; you can cancel later.',
        ctxOpen: 'Open',
        ctxArchive: 'Archive',
        ctxArchiveHint: 'Read-only: history readable, sending rejected',
        ctxToStrong: 'Make strong archive',
        ctxToStrongHint: 'Hidden from the sidebar, greyed in the panel',
        ctxUnarchive: 'Cancel archive',
        ctxUnarchiveHint: 'Back to a normal conversation',
        ctxNewSession: 'New conversation under this agent',
        ctxNewSessionHint: 'Creates and binds it to this agent',
        ctxCollapse: 'Collapse this agent',
        ctxExpand: 'Expand this agent',
        ctxSelected: 'Selected',
        ctxUnit: 'conversations',
        ctxDoneArchive: 'Archived',
        ctxDoneStrong: 'Strong-archived',
        ctxDoneUnarchive: 'Archive cancelled',
        ctxDoneNew: 'New conversation created and bound',
        ctxFailed: 'Action failed',
        ctxTip: 'Right-click a conversation to archive, strong-archive, cancel the archive, or start a new one; Ctrl / Shift click multi-selects',
        recall: 'Recall',
        recallHint: 'Keyword search over this agent’s journal, its memory audit log and the shared knowledge base. Index-only: it never enters the prompt and costs no tokens.',
        recallPlaceholder: 'What are you looking for?',
        recallSearch: 'Search',
        recallClear: 'Clear',
        recallEmpty: 'Nothing searched yet. Type a few keywords.',
        recallNoResult: 'No hits. Try another wording, or loosen the source and date filters.',
        recallUnit: 'hits',
        recallAll: 'All sources',
        recallSince: 'Since',
        recallExpandSoon: 'A "related·" badge marks a one-hop neighbour reached through a citation, a shared entity, or the same session; the expanded row says what it is related via.',
        recallIndex: 'Index status',
        recallIndexTotal: 'entries',
        recallBuilt: 'built',
        recallRebuild: 'Rebuild index',
        recallRebuilt: 'Index rebuilt',
        recallSrcJournal: 'journal',
        recallSrcLog: 'memory',
        recallSrcKnowledge: 'knowledge',
        transcripts: 'Index conversations',
        transcriptsHint: 'Index the user and assistant text of sessions this agent handed off or is bound to, so recall can search them. Tool results and reasoning stay out, secrets are masked, and each session is capped at 12000 characters. Changes need a host restart to fully apply.',
        recallSrcSession: 'conversation',
        recallGoSession: 'Go to conversation',
        recallOpen: 'Open',
        recallClose: 'Close',
        recallScore: 'score',
        recallViaAlias: 'related·alias',
        recallViaRef: 'related·citation',
        recallViaEntity: 'related·entity',
        recallViaSession: 'related·session',
        recallWhy: 'related via',
      },
    }

    const CSS = `
.am-root{height:100%;min-height:0;display:flex;align-items:stretch;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);overflow:hidden}
.am-side{width:264px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 40%,transparent)}
.am-side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px 14px 10px}
.am-side-title{font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.am-vaults{flex:1;min-height:0;overflow-y:auto;padding:0 8px 8px;display:flex;flex-direction:column;gap:2px}
.am-vault{display:flex;flex-direction:column;gap:2px;align-items:flex-start;width:100%;text-align:left;padding:9px 10px;border-radius:10px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;cursor:pointer;transition:background .14s ease,border-color .14s ease}
.am-vault:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent);border-color:var(--dsw-alias-border-l1)}
.am-vault.is-active{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent)}
.am-vault-row{display:flex;align-items:center;gap:6px;width:100%}
.am-vault-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.am-vault-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.am-badge{flex:none;font-size:10px;font-weight:650;padding:1px 7px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.am-side-foot{padding:10px 14px 14px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px}
.am-side-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.am-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;color:var(--dsw-alias-label-secondary);line-height:1.45}
.am-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.am-head{display:flex;align-items:flex-start;gap:16px;padding:20px 26px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.am-head-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.am-head-name{margin:0;font-size:17px;font-weight:700;letter-spacing:-.2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.am-head-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.am-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.am-switch{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;padding:5px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent)}
.am-switch input{appearance:none;width:26px;height:15px;border-radius:999px;background:var(--dsw-alias-border-l2);position:relative;cursor:pointer;transition:background .16s ease;flex:none;margin:0}
.am-switch input::after{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-label-on-accent,#fff);transition:transform .16s ease}
.am-switch input:checked{background:var(--dsw-alias-state-success-primary)}
.am-switch input:checked::after{transform:translateX(11px)}
.am-tabs{display:flex;gap:4px;padding:10px 26px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.am-tab{padding:7px 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-weight:600;cursor:pointer}
.am-tab.is-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary)}
.am-body{flex:1;min-height:0;overflow-y:auto;padding:18px 26px 26px;display:flex;flex-direction:column;gap:12px}
.am-note{margin:0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.am-note-dim{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.am-textarea{width:100%;box-sizing:border-box;min-height:210px;resize:vertical;padding:12px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);color:inherit;font:inherit;line-height:1.7;outline:none}
.am-textarea-sm{min-height:78px}
.am-textarea:focus,.am-input:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-border-l1))}
.am-textarea.is-over{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary)) 60%,var(--dsw-alias-border-l1))}
.am-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.am-row-end{justify-content:flex-end}
.am-counter{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.am-counter.is-over{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary))}
.am-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-weight:600;cursor:pointer;transition:border-color .14s ease,color .14s ease,background .14s ease}
.am-btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.am-btn:disabled{opacity:.5;cursor:default}
.am-btn-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent,#fff)}
.am-btn-primary:hover:not(:disabled){color:var(--dsw-alias-label-on-accent,#fff);filter:brightness(1.05)}
.am-btn-ghost{border-color:transparent;background:transparent}
.am-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-business-primary)) 45%,transparent);color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-business-primary));background:transparent}
.am-btn-sm{padding:4px 10px;font-size:12px;border-radius:8px}
.am-input{width:100%;box-sizing:border-box;padding:8px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);color:inherit;font:inherit;outline:none}
.am-field{display:flex;flex-direction:column;gap:5px}
.am-label{font-size:11px;font-weight:650;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.am-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
.am-list{display:flex;flex-direction:column;gap:6px}
.am-recall-hit{display:flex;flex-direction:column;gap:6px}
.am-recall-detail{white-space:pre-wrap;padding:10px 12px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 30%,transparent);font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-height:320px;overflow:auto}
.am-item{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent);color:inherit;font:inherit;cursor:pointer}
.am-item:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,var(--dsw-alias-border-l1))}
.am-item-title{font-weight:650;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.am-item-snippet{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.am-item-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;gap:10px;flex-wrap:wrap}
.am-tag{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}
.am-error{margin:0;padding:10px 12px;border-radius:10px;font-size:12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-business-primary)) 45%,transparent);color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-business-primary));background:color-mix(in srgb,var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-business-primary)) 8%,transparent)}
.am-toast{font-size:12px;color:var(--dsw-alias-state-success-primary)}
.am-divider{height:1px;background:var(--dsw-alias-border-l1);margin:4px 0}
.am-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.am-usage-title{font-weight:600;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-side-agents{flex:none;display:flex;flex-direction:column;padding:2px 0;margin:6px 0 8px}
.am-side-agents.is-collapsed .am-side-agents-list,.am-side-agents.is-collapsed .am-side-view{display:none}
.am-side-agents-head{box-sizing:border-box;display:flex;align-items:center;gap:6px;height:38px;margin:0 0 6px;padding-left:6px;color:var(--dsw-alias-label-tertiary);overflow:hidden}
.am-side-agents-title{font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);background:none;border:0;padding:0;cursor:pointer;white-space:nowrap}
.am-side-agents-title:hover{color:var(--dsw-alias-label-secondary)}
.am-side-agents-count{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.am-side-agents-actions{margin-left:auto;display:flex;align-items:center;gap:4px;flex:none}
.am-side-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;font-family:inherit;font-size:13px;line-height:1}
.am-side-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.am-side-agents-toggle svg{transition:transform .15s var(--ds-ease-in-out)}
.am-side-agents-toggle.is-open svg{transform:rotate(90deg)}
.am-side-search{display:none;flex:1;min-width:0;align-items:center;gap:2px}
.am-side-agents-head.is-searching .am-side-agents-title,.am-side-agents-head.is-searching .am-side-agents-count,.am-side-agents-head.is-searching .am-side-agents-actions{display:none}
.am-side-agents-head.is-searching .am-side-search{display:flex}
.am-side-search-input{flex:1;min-width:0;height:28px;padding:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:18px}
.am-side-search-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.am-side-agents-list{display:flex;flex-direction:column;gap:2px;max-height:min(52vh,420px);overflow:auto;scrollbar-width:thin}
.am-side-agent{display:flex;flex-direction:column}
.am-side-agent-row{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:20px;cursor:pointer;text-align:left;user-select:none}
.am-side-agent-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.am-side-agent-chevron{width:14px;height:14px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);transition:transform .15s var(--ds-ease-in-out)}
.am-side-agent-chevron.is-open{transform:rotate(90deg)}
.am-side-agent-slot{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.am-side-agent-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-side-agent-count{flex:none;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.am-side-sessions{display:flex;flex-direction:column;gap:2px;padding:2px 0 6px 16px}
.am-side-session{display:flex;align-items:center;gap:8px;width:100%;height:34px;padding:0 10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:20px;cursor:pointer;text-align:left;user-select:none}
.am-side-session:hover{background:var(--dsw-alias-interactive-bg-hover)}
.am-side-session-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-side-session-meta{flex:none;max-width:45%;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-side-session-state{flex:none;display:inline-flex;align-items:center;gap:4px}
.am-side-session-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}
.am-side-session-tag{font-size:10px;line-height:16px;padding:0 4px;border-radius:4px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1)}
.am-side-session.is-weak{opacity:.6}
.am-side-view{display:flex;flex-direction:column;gap:2px;margin:2px 6px 8px;padding:6px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 96%,transparent);box-shadow:0 8px 24px rgba(0,0,0,.18)}
.am-side-view[hidden]{display:none}
.am-side-view-title{padding:8px 10px 3px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.am-side-view-item{display:flex;align-items:center;justify-content:space-between;width:100%;height:30px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:18px;cursor:pointer;text-align:left}
.am-side-view-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.am-side-view-item.is-active::after{content:'✓';font-size:11px;color:var(--dsw-alias-state-business-primary)}
.am-side-empty{padding:16px 10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);text-align:center}
.am-card.is-strong{opacity:.5}
.am-archive-banner{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 94%,transparent);box-shadow:0 6px 24px rgba(0,0,0,.25);font-size:12px;color:var(--dsw-alias-label-secondary)}
.am-view-tabs{display:flex;gap:4px;padding:0 10px 8px}
.am-view-tab{flex:1;padding:5px 8px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.am-view-tab:hover{color:var(--dsw-alias-label-primary)}
.am-view-tab.is-active{border-color:var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);color:var(--dsw-alias-label-primary)}
.am-room-members{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 26px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.am-member{padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer}
.am-member:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.am-member.is-in{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.am-room-flow{flex:1;min-height:0;overflow-y:auto;padding:16px 26px;display:flex;flex-direction:column;gap:12px}
.am-msg{display:flex;flex-direction:column;gap:3px;max-width:720px}
.am-msg-head{display:flex;align-items:baseline;gap:8px}
.am-msg-from{font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary)}
.am-msg-text{font-size:13px;line-height:1.65;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}
.am-room-compose{display:flex;flex-direction:column;gap:8px;padding:12px 26px 18px;border-top:1px solid var(--dsw-alias-border-l1)}
.am-split{display:flex;flex-direction:column;gap:10px;max-width:760px}
.am-card{padding:14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 35%,transparent);display:flex;flex-direction:column;gap:9px}
.am-danger-card{border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-business-primary)) 40%,transparent)}
.am-hero{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.am-hero select{font:inherit;font-size:12px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);color:var(--dsw-alias-label-primary);outline:none;max-width:150px}
.am-hero select:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-border-l1))}
.am-ctx{position:fixed;z-index:90;display:flex;flex-direction:column;gap:1px;min-width:212px;max-width:min(320px,90vw);padding:4px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 98%,transparent);box-shadow:0 12px 32px rgba(0,0,0,.3);font-family:inherit}
.am-ctx-head{padding:6px 10px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-ctx-item{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;box-sizing:border-box;padding:6px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.am-ctx-item:hover:not(:disabled),.am-ctx-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.am-ctx-item:disabled{opacity:.45;cursor:default}
.am-ctx-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.am-ctx-sep{height:1px;margin:3px 4px;background:var(--dsw-alias-border-l1)}
.am-side-session.is-selected,.am-side-agent-row.is-selected{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}
.am-side-session.is-selected:hover,.am-side-agent-row.is-selected:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.am-toast-bar{position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:90;padding:7px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 96%,transparent);box-shadow:0 8px 26px rgba(0,0,0,.24);font-size:12px;color:var(--dsw-alias-label-secondary);pointer-events:none}
.am-toast-bar.is-failed{color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary,var(--dsw-alias-border-l2)) 45%,transparent)}
`

    // ── locale ──────────────────────────────────────────────────────────────
    const localeListeners = new Set()
    function subscribeLocale(fn) {
      localeListeners.add(fn)
      return () => {
        localeListeners.delete(fn)
      }
    }

    function useLocale(props) {
      const [, bump] = useState(0)
      useEffect(() => subscribeLocale(() => bump(value => value + 1)), [])
      return props.t
    }

    // ── transport ───────────────────────────────────────────────────────────
    const API = (() => {
      try {
        return new URL('api/agent-memory', document.baseURI).pathname
      } catch {
        return '/api/agent-memory'
      }
    })()

    async function request(path, options) {
      const { timeout = 15000, ...rest } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, redirect: 'error', signal: controller.signal })
        const text = await response.text()
        let payload
        try {
          payload = text === '' ? {} : JSON.parse(text)
        } catch {
          payload = { error: { code: 'bad-body', message: text.slice(0, 200) } }
        }
        if (!response.ok) {
          const message = payload?.error?.message ?? payload?.error?.code ?? `HTTP ${response.status}`
          const error = new Error(message)
          error.code = payload?.error?.code
          throw error
        }
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    function ago(value, locale) {
      if (!value) return ''
      const time = Date.parse(value)
      if (Number.isNaN(time)) return ''
      const seconds = Math.max(1, Math.round((Date.now() - time) / 1000))
      const zh = String(locale ?? '').toLowerCase().startsWith('zh')
      if (seconds < 60) return zh ? `${seconds} 秒前` : `${seconds}s ago`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
      const days = Math.round(hours / 24)
      return zh ? `${days} 天前` : `${days}d ago`
    }

    // ── controls ────────────────────────────────────────────────────────────
    function Switch(props) {
      return h(
        'label',
        { className: 'am-switch', title: props.hint },
        h('input', {
          type: 'checkbox',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: event => props.onChange(event.target.checked),
        }),
        h('span', null, props.label),
      )
    }

    function Field(props) {
      return h('label', { className: 'am-field' }, h('span', { className: 'am-label' }, props.label), props.children)
    }

    // ── page ────────────────────────────────────────────────────────────────
    function Panel(props) {
      const t = useLocale(props)
      const locale = typeof props.getLocale === 'function' ? props.getLocale() : ''
      const [data, setData] = useState(null)
      const [failure, setFailure] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [tab, setTab] = useState('memory')
      const [selectedId, setSelectedId] = useState('')
      const [memoryDraft, setMemoryDraft] = useState('')
      const [entries, setEntries] = useState([])
      const [query, setQuery] = useState('')
      const [results, setResults] = useState(null)
      const [editor, setEditor] = useState(null)
      const [creating, setCreating] = useState(false)
      const [draftName, setDraftName] = useState('')
      const [draftDesc, setDraftDesc] = useState('')
      const [dirDraft, setDirDraft] = useState('')
      const [kbVersion, setKbVersion] = useState(0)
      const [view, setView] = useState('agents')
      const [rooms, setRooms] = useState([])
      const [roomId, setRoomId] = useState('')
      const [roomData, setRoomData] = useState(null)
      const [roomDraft, setRoomDraft] = useState('')
      const [roomName, setRoomName] = useState('')
      const [roomCreating, setRoomCreating] = useState(false)
      const [roomVersion, setRoomVersion] = useState(0)
      const [journal, setJournal] = useState([])
      const [journalEditor, setJournalEditor] = useState(null)
      const [journalVersion, setJournalVersion] = useState(0)
      const [handoffInfo, setHandoffInfo] = useState(null)
      const [handoffDraft, setHandoffDraft] = useState({
        triggerTokens: 300000,
        remindEverySteps: 2,
        exportDir: '',
        startupPrompt: '',
      })
      const [handoffVersion, setHandoffVersion] = useState(0)
      const [sessionsInfo, setSessionsInfo] = useState({ sessions: [], workspaces: [] })
      const [sessionsWorkspace, setSessionsWorkspace] = useState('')
      const [sessionsVersion, setSessionsVersion] = useState(0)
      // Recall tab: results are index-only, so they never touch the prompt.
      const [recallData, setRecallData] = useState(null)
      const [recallQuery, setRecallQuery] = useState('')
      const [recallSource, setRecallSource] = useState('')
      const [recallSince, setRecallSince] = useState('')
      const [recallDetail, setRecallDetail] = useState(null)
      const [indexData, setIndexData] = useState(null)
      const [indexVersion, setIndexVersion] = useState(0)
      const draftKey = useRef('')
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      // The sidebar "+" button opens this panel and asks for the create form.
      // The panel may not be mounted yet, so the request is kept until it is.
      useEffect(() => {
        const handler = () => {
          setView('agents')
          setTab('memory')
          setCreating(true)
          setDraftName('')
          setDraftDesc('')
        }
        sidebarBridge.onRequestCreateAgent = handler
        if (sidebarBridge.createAgent) {
          sidebarBridge.createAgent = false
          handler()
        }
        return () => {
          if (sidebarBridge.onRequestCreateAgent === handler) sidebarBridge.onRequestCreateAgent = null
        }
      }, [])

      const applyState = useCallback(next => {
        if (!next || !alive.current) return
        setData(next)
        setSelectedId(current => {
          if (current !== '' && next.vaults.some(item => item.id === current)) return current
          if (next.activeVault !== '') return next.activeVault
          return next.vaults.length > 0 ? next.vaults[0].id : ''
        })
      }, [])

      const reload = useCallback(async () => {
        try {
          const payload = await request('/state')
          applyState(payload.state)
          setFailure('')
        } catch (error) {
          setFailure(String(error?.message ?? error))
        }
      }, [applyState])

      useEffect(() => {
        void reload()
      }, [reload])

      const call = useCallback(
        async (op, args) => {
          setBusy(op)
          setNotice('')
          try {
            const payload = await request('/op', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ op, args: args ?? {} }),
            })
            applyState(payload.state)
            setFailure('')
            return payload.value
          } catch (error) {
            setNotice('')
            setFailure(String(error?.message ?? error))
            return undefined
          } finally {
            setBusy('')
          }
        },
        [applyState],
      )

      const vault = useMemo(() => (data ? data.vaults.find(item => item.id === selectedId) ?? null : null), [data, selectedId])
      const usage = useMemo(
        () => (data && vault ? (data.bindings ?? []).filter(item => item.agentId === vault.id) : []),
        [data, vault],
      )

      useEffect(() => {
        if (!vault) return
        const key = `${vault.id}@${vault.memoryUpdatedAt}@${vault.memory.length}`
        if (draftKey.current === key) return
        draftKey.current = key
        setMemoryDraft(vault.memory.replace(/\s+$/, ''))
      }, [vault])

      useEffect(() => {
        if (!vault || tab !== 'knowledge') return
        let live = true
        request('/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'knowledge.list', args: {} }),
        })
          .then(payload => {
            if (!live) return
            setEntries(payload.value?.entries ?? [])
            applyState(payload.state)
          })
          .catch(error => {
            if (live) setFailure(String(error?.message ?? error))
          })
        return () => {
          live = false
        }
      }, [vault?.id, tab, kbVersion, applyState])

      // rooms and the private journal load lazily, only while their view is open
      useEffect(() => {
        if (view !== 'rooms') return undefined
        let live = true
        request('/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'room.list', args: {} }),
        })
          .then(payload => {
            if (!live) return
            const list = payload.value?.rooms ?? []
            setRooms(list)
            setRoomId(current => (current !== '' && list.some(item => item.id === current) ? current : list[0]?.id ?? ''))
          })
          .catch(error => {
            if (live) setFailure(String(error?.message ?? error))
          })
        return () => {
          live = false
        }
      }, [view, roomVersion])

      useEffect(() => {
        if (roomId === '') {
          setRoomData(null)
          return undefined
        }
        let live = true
        request('/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'room.read', args: { id: roomId } }),
        })
          .then(payload => {
            if (live) setRoomData(payload.value ?? null)
          })
          .catch(error => {
            if (live) setFailure(String(error?.message ?? error))
          })
        return () => {
          live = false
        }
      }, [roomId, roomVersion])

      useEffect(() => {
        if (!vault || tab !== 'journal') return undefined
        let live = true
        request('/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'journal.list', args: { id: vault.id } }),
        })
          .then(payload => {
            if (live) setJournal(payload.value?.entries ?? [])
          })
          .catch(error => {
            if (live) setFailure(String(error?.message ?? error))
          })
        return () => {
          live = false
        }
      }, [vault?.id, tab, journalVersion])

      useEffect(() => {
        if (tab !== 'handoff') return undefined
        let live = true
        request('/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'handoff.status', args: {} }),
        })
          .then(payload => {
            if (!live) return
            const value = payload.value ?? null
            setHandoffInfo(value)
            if (value) {
              setHandoffDraft({
                triggerTokens: value.config.triggerTokens,
                remindEverySteps: value.config.remindEverySteps,
                exportDir: value.config.exportDir,
                startupPrompt: value.config.startupPrompt ?? '',
              })
            }
          })
          .catch(error => {
            if (live) setFailure(String(error?.message ?? error))
          })
        return () => {
          live = false
        }
      }, [tab, handoffVersion])

      useEffect(() => {
        // A different agent may live in other workspaces; let the fetch pick
        // the most recent one instead of keeping the previous agent's choice.
        setSessionsWorkspace('')
      }, [vault?.id])

      useEffect(() => {
        if (!vault || tab !== 'sessions') return undefined
        let live = true
        Promise.all([
          request('/op', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'agent.sessions', args: { id: vault.id } }),
          }),
          request('/op', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'workspace.list', args: {} }),
          }),
        ])
          .then(([sessionPayload, workspacePayload]) => {
            if (!live) return
            const sessions = sessionPayload.value?.sessions ?? []
            const workspaces = workspacePayload.value?.workspaces ?? []
            setSessionsInfo({ sessions, workspaces })
            setSessionsWorkspace(current => {
              if (current !== '' && workspaces.some(item => item.id === current)) return current
              const recent = sessions.find(item => item.workspaceId !== '')
              return recent?.workspaceId ?? workspaces[0]?.id ?? ''
            })
          })
          .catch(error => {
            if (live) setFailure(String(error?.message ?? error))
          })
        return () => {
          live = false
        }
      }, [vault?.id, tab, sessionsVersion])

      useEffect(() => {
        if (tab !== 'recall') return undefined
        let live = true
        request('/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'memory.index', args: {} }),
        })
          .then(payload => {
            if (live) setIndexData(payload.value ?? null)
          })
          .catch(error => {
            if (live) setFailure(String(error?.message ?? error))
          })
        return () => {
          live = false
        }
      }, [tab, indexVersion])

      useEffect(() => {
        if (data) setDirDraft(data.knowledgeDirConfigured ?? '')
      }, [data?.knowledgeDirConfigured])

      const select = id => {
        setSelectedId(id)
        setEditor(null)
        setResults(null)
        setQuery('')
      }

      const openRoom = id => {
        setRoomId(id)
        setRoomDraft('')
      }

      const createRoom = async () => {
        const name = roomName.trim()
        if (name === '') return
        const created = await call('room.create', { name })
        setRoomCreating(false)
        setRoomName('')
        setRoomVersion(value => value + 1)
        if (created?.id) setRoomId(created.id)
      }

      const deleteRoom = async () => {
        if (!roomData?.room) return
        if (!window.confirm(`${t('deleteRoom')} “${roomData.room.name}”?`)) return
        await call('room.delete', { id: roomData.room.id })
        setRoomId('')
        setRoomData(null)
        setRoomVersion(value => value + 1)
      }

      const sendRoom = async () => {
        const text = roomDraft.trim()
        if (text === '' || roomId === '') return
        const sent = await call('room.say', { id: roomId, text })
        if (sent) {
          setRoomDraft('')
          setRoomVersion(value => value + 1)
        }
      }

      const toggleMember = async agentId => {
        if (!roomData?.room) return
        const current = roomData.room.members ?? []
        const members = current.includes(agentId) ? current.filter(item => item !== agentId) : [...current, agentId]
        await call('room.members', { id: roomData.room.id, members })
        setRoomVersion(value => value + 1)
      }

      const saveHandoff = async patch => {
        const value = await call('handoff.save', patch)
        if (value) setHandoffVersion(item => item + 1)
      }

      const resetHandoff = async sessionId => {
        if (!window.confirm(t('handoffResetConfirm'))) return
        const value = await call('handoff.reset', { sessionId })
        if (value) setHandoffVersion(item => item + 1)
      }

      const continueHandoff = async sessionId => {
        const armed = await call('handoff.arm', { sessionId })
        if (!armed) return
        const ui = typeof props.uiWorkspace === 'function' ? props.uiWorkspace() : undefined
        if (!ui || typeof ui.startSession !== 'function') {
          setFailure(t('handoffNoWorkspace'))
          return
        }
        // Inherit the source session's workspace and Agent preset, not whatever
        // tab or mode was last used.
        ui.startSession(
          armed.workspaceId || undefined,
          armed.agentPreset ? { agentPreset: armed.agentPreset } : undefined,
        )
        setHandoffVersion(item => item + 1)
      }

      const sessionsUi = () => (typeof props.uiWorkspace === 'function' ? props.uiWorkspace() : undefined)

      const openBoundSession = sessionId => {
        const ui = sessionsUi()
        if (!ui || typeof ui.openSession !== 'function') {
          setFailure(t('handoffNoWorkspace'))
          return
        }
        ui.openSession(sessionId)
      }

      const newBoundSession = async () => {
        if (!vault) return
        const ui = sessionsUi()
        if (!ui || typeof ui.openSession !== 'function') {
          setFailure(t('handoffNoWorkspace'))
          return
        }
        const created = await call('agent.newSession', { id: vault.id, workspaceId: sessionsWorkspace })
        if (created?.sessionId) {
          ui.openSession(created.sessionId)
          setSessionsVersion(value => value + 1)
        }
      }

      const switchWorkspace = async workspaceId => {
        if (workspaceId === '') return
        const ui = sessionsUi()
        if (!ui || typeof ui.openWorkspace !== 'function') {
          setFailure(t('handoffNoWorkspace'))
          return
        }
        try {
          await ui.openWorkspace(workspaceId)
        } catch (error) {
          setFailure(String(error?.message ?? error))
        }
      }

      const saveHideBound = async checked => {
        await call('settings.save', { hideBoundSessions: checked })
      }

      const saveTranscripts = async checked => {
        await call('settings.save', { transcripts: checked })
        setIndexVersion(current => current + 1)
      }

      const unbindBoundSession = async sessionId => {
        await unbindSession(sessionId)
        setSessionsVersion(value => value + 1)
      }

      const setArchive = async (sessionId, level) => {
        const value = await call('archive.set', { sessionId, level })
        if (value) setSessionsVersion(item => item + 1)
      }

      const journalOpen = async entryId => {
        if (!vault) return
        const entry = await call('journal.read', { id: vault.id, entry: entryId })
        if (entry) setJournalEditor({ id: entry.id, title: entry.title, text: entry.text })
      }

      const journalNew = () => setJournalEditor({ id: '', title: '', text: '' })

      const journalSave = async () => {
        if (!vault || !journalEditor) return
        if (journalEditor.text.trim() === '') return
        const saved = await call('journal.write', { id: vault.id, title: journalEditor.title, text: journalEditor.text })
        if (saved) {
          setJournalEditor(null)
          setJournalVersion(value => value + 1)
          setNotice(t('noticeSaved'))
        }
      }

      const journalDelete = async () => {
        if (!vault || !journalEditor || journalEditor.id === '') return
        if (!window.confirm(t('deleteEntry'))) return
        const removed = await call('journal.delete', { id: vault.id, entry: journalEditor.id })
        if (removed) {
          setJournalEditor(null)
          setJournalVersion(value => value + 1)
        }
      }

      const saveMemory = async () => {
        if (!vault) return
        const value = await call('memory.save', { id: vault.id, content: memoryDraft })
        if (value) setNotice(t('noticeSaved'))
      }

      const createVault = async () => {
        const name = draftName.trim()
        if (name === '') return
        const created = await call('vault.create', { name, description: draftDesc })
        if (created?.id) {
          setSelectedId(created.id)
          setTab('memory')
        }
        setCreating(false)
        setDraftName('')
        setDraftDesc('')
      }

      const unbindSession = async sessionId => {
        await call('binding.set', { sessionId, agentId: '' })
      }

      const deleteVault = async () => {
        if (!vault) return
        if (!window.confirm(t('deleteVaultConfirm').replace('{name}', vault.name))) return
        const removed = await call('vault.delete', { id: vault.id, deleteKnowledge: false })
        if (removed) {
          setTab('memory')
          setEditor(null)
        }
      }

      const toggleInherit = async checked => {
        if (!vault) return
        await call('vault.activate', { id: checked ? vault.id : '' })
      }

      const runRecall = async () => {
        if (!vault) return
        const text = recallQuery.trim()
        if (text === '') {
          setRecallData(null)
          setRecallDetail(null)
          return
        }
        const found = await call('memory.recall', {
          id: vault.id,
          query: text,
          limit: 25,
          source: recallSource === '' ? undefined : recallSource,
          since: recallSince === '' ? undefined : recallSince,
        })
        setRecallData(found ?? null)
        setRecallDetail(null)
      }

      const openRecallHit = async hit => {
        if (!vault) return
        if (recallDetail !== null && recallDetail.id === hit.id && recallDetail.src === hit.src) {
          setRecallDetail(null)
          return
        }
        const opened = await call('memory.open', { id: vault.id, src: hit.src, entry: hit.id })
        const entry = opened?.entry ?? null
        setRecallDetail(
          entry === null ? null : { ...entry, sessionId: entry.sessionId ?? hit.sessionId ?? '', via: hit.via, why: hit.why ?? null },
        )
      }

      const goToSession = async sessionId => {
        const ui = sessionsUi()
        if (ui === undefined || typeof ui.openSession !== 'function' || sessionId === '') return
        await ui.openSession(sessionId)
      }

      const rebuildIndex = async () => {
        const rebuilt = await call('memory.reindex', {})
        if (rebuilt !== undefined) setIndexVersion(current => current + 1)
      }

      const search = async () => {
        if (!vault) return
        const text = query.trim()
        if (text === '') {
          setResults(null)
          return
        }
        const found = await call('knowledge.search', { id: vault.id, query: text, limit: 25 })
        setResults(found?.entries ?? [])
      }

      const openEntry = async entryId => {
        if (!vault) return
        const entry = await call('knowledge.read', { id: vault.id, entry: entryId })
        if (!entry) return
        setEditor({
          id: entry.id,
          title: entry.title,
          tags: (entry.tags ?? []).join(', '),
          content: entry.content,
        })
      }

      const saveEntry = async () => {
        if (!vault || !editor) return
        if (editor.content.trim() === '') return
        const saved = await call('knowledge.save', {
          id: vault.id,
          entry: editor.id === '' ? undefined : editor.id,
          title: editor.title,
          tags: editor.tags,
          content: editor.content,
        })
        if (saved) {
          setEditor({ id: saved.entry, title: saved.title ?? editor.title, tags: editor.tags, content: editor.content })
          setKbVersion(value => value + 1)
          setNotice(t('noticeSaved'))
        }
      }

      const deleteEntry = async () => {
        if (!vault || !editor || editor.id === '') return
        if (!window.confirm(`${t('deleteEntry')} “${editor.title || editor.id}”?`)) return
        const removed = await call('knowledge.delete', { id: vault.id, entry: editor.id })
        if (removed) {
          setEditor(null)
          setKbVersion(value => value + 1)
        }
      }

      const saveDir = async () => {
        await call('settings.save', { knowledgeDir: dirDraft })
        setNotice(t('noticeSaved'))
      }

      if (failure !== '' && data === null) {
        return h(
          'div',
          { className: 'am-root' },
          h(
            'div',
            { className: 'am-empty' },
            h('div', null, t('loadFailed')),
            h('div', { className: 'am-note-dim' }, failure),
            h('button', { className: 'am-btn am-btn-sm', onClick: () => void reload() }, t('retry')),
          ),
        )
      }

      if (data === null) {
        return h('div', { className: 'am-root' }, h('div', { className: 'am-empty' }, t('busy')))
      }

      const limit = data.memoryLimit
      const over = memoryDraft.length > limit
      const list = results ?? entries

      const sideHead = h(
        'div',
        { className: 'am-side-head' },
        h('span', { className: 'am-side-title' }, view === 'rooms' ? t('rooms') : t('agents')),
        h(
          'button',
          {
            className: 'am-btn am-btn-sm',
            onClick: () => (view === 'rooms' ? setRoomCreating(value => !value) : setCreating(value => !value)),
          },
          `+ ${t('create')}`,
        ),
      )

      const viewTabs = h(
        'div',
        { className: 'am-view-tabs' },
        h(
          'button',
          { className: `am-view-tab${view === 'agents' ? ' is-active' : ''}`, onClick: () => setView('agents') },
          t('agents'),
        ),
        h(
          'button',
          { className: `am-view-tab${view === 'rooms' ? ' is-active' : ''}`, onClick: () => setView('rooms') },
          t('rooms'),
        ),
      )

      const createCard =
        view === 'rooms'
          ? roomCreating
            ? h(
                'div',
                { className: 'am-card', style: { margin: '0 10px 10px' } },
                h(Field, { label: t('roomName') }, h('input', {
                  className: 'am-input',
                  value: roomName,
                  placeholder: t('roomNamePlaceholder'),
                  autoFocus: true,
                  onChange: event => setRoomName(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter') void createRoom()
                  },
                })),
                h(
                  'div',
                  { className: 'am-row am-row-end' },
                  h('button', { className: 'am-btn am-btn-sm am-btn-ghost', onClick: () => setRoomCreating(false) }, t('cancel')),
                  h(
                    'button',
                    {
                      className: 'am-btn am-btn-sm am-btn-primary',
                      disabled: roomName.trim() === '',
                      onClick: () => void createRoom(),
                    },
                    t('confirm'),
                  ),
                ),
              )
            : null
          : creating
            ? h(
                'div',
                { className: 'am-card', style: { margin: '0 10px 10px' } },
                h(Field, { label: t('name') }, h('input', {
                  className: 'am-input',
                  value: draftName,
                  placeholder: t('namePlaceholder'),
                  autoFocus: true,
                  onChange: event => setDraftName(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter') void createVault()
                  },
                })),
                h(Field, { label: t('desc') }, h('input', {
                  className: 'am-input',
                  value: draftDesc,
                  placeholder: t('descPlaceholder'),
                  onChange: event => setDraftDesc(event.target.value),
                })),
                h(
                  'div',
                  { className: 'am-row am-row-end' },
                  h('button', { className: 'am-btn am-btn-sm am-btn-ghost', onClick: () => setCreating(false) }, t('cancel')),
                  h(
                    'button',
                    {
                      className: 'am-btn am-btn-sm am-btn-primary',
                      disabled: draftName.trim() === '',
                      onClick: () => void createVault(),
                    },
                    t('confirm'),
                  ),
                ),
              )
            : null

      const sideList = h(
        'div',
        { className: 'am-vaults' },
        view === 'rooms'
          ? rooms.length === 0
            ? h('p', { className: 'am-note-dim', style: { padding: '8px 10px' } }, t('roomsEmpty'))
            : rooms.map(room =>
                h(
                  'button',
                  {
                    key: room.id,
                    className: `am-vault${room.id === roomId ? ' is-active' : ''}`,
                    onClick: () => openRoom(room.id),
                  },
                  h('span', { className: 'am-vault-row' }, h('span', { className: 'am-vault-name' }, room.name)),
                  h(
                    'span',
                    { className: 'am-vault-meta' },
                    `${room.members.length} ${t('membersUnit')} · ${room.count} ${t('messagesUnit')}`,
                  ),
                ),
              )
          : data.vaults.length === 0
            ? h('p', { className: 'am-note-dim', style: { padding: '8px 10px' } }, t('emptyList'))
            : data.vaults.map(item =>
                h(
                  'button',
                  {
                    key: item.id,
                    className: `am-vault${item.id === selectedId ? ' is-active' : ''}`,
                    onClick: () => select(item.id),
                  },
                  h(
                    'span',
                    { className: 'am-vault-row' },
                    h('span', { className: 'am-vault-name' }, item.name),
                    item.id === data.activeVault ? h('span', { className: 'am-badge' }, t('active')) : null,
                  ),
                  h(
                    'span',
                    { className: 'am-vault-meta' },
                    t('vaultMeta')
                      .replace('{m}', String(item.memoryChars))
                      .replace('{limit}', String(limit))
                      .replace('{k}', String(item.knowledgeCount))
                      .replace('{u}', String((data.bindings ?? []).filter(entry => entry.agentId === item.id).length)),
                  ),
                ),
              ),
      )

      const side = h(
        'aside',
        { className: 'am-side' },
        sideHead,
        viewTabs,
        createCard,
        sideList,
        h(
          'div',
          { className: 'am-side-foot' },
          h('span', { className: 'am-side-label' }, t('dirTitle')),
          h('span', { className: 'am-path' }, data.knowledgeDir),
        ),
      )

      let body
      if (vault === null) {
        body = h('div', { className: 'am-empty' }, t('emptyPick'))
      } else if (tab === 'memory') {
        body = h(
          'div',
          { className: 'am-split' },
          h('p', { className: 'am-note' }, t('memoryHint')),
          h('textarea', {
            className: `am-textarea${over ? ' is-over' : ''}`,
            value: memoryDraft,
            placeholder: t('memoryPlaceholder'),
            spellCheck: false,
            onChange: event => setMemoryDraft(event.target.value),
          }),
          h(
            'div',
            { className: 'am-row' },
            h('span', { className: `am-counter${over ? ' is-over' : ''}` }, `${memoryDraft.length} / ${limit} ${t('chars')}`),
            over ? h('span', { className: 'am-counter is-over' }, t('overLimit')) : null,
            h('span', { style: { flex: 1 } }),
            notice === t('noticeSaved') ? h('span', { className: 'am-toast' }, notice) : null,
            h(
              'button',
              {
                className: 'am-btn am-btn-primary',
                disabled: over || busy !== '' || memoryDraft.trim() === vault.memory.trim(),
                onClick: () => void saveMemory(),
              },
              t('save'),
            ),
          ),
          h('div', { className: 'am-divider' }),
          h(
            'p',
            { className: 'am-note-dim' },
            `${t('memoryMeta')} ${vault.memoryUpdatedAt ? ago(vault.memoryUpdatedAt, locale) : t('never')}`,
          ),
          h('div', { className: 'am-divider' }),
          h('span', { className: 'am-label' }, t('usageTitle')),
          usage.length === 0
            ? h('p', { className: 'am-note-dim' }, t('usageEmpty'))
            : h(
                'div',
                { className: 'am-list' },
                usage.map(item =>
                  h(
                    'div',
                    { key: item.sessionId, className: 'am-row' },
                    h('span', { className: 'am-tag' }, t('usageTag')),
                    h(
                      'span',
                      { className: 'am-usage-title', title: item.sessionId },
                      item.title || t('untitled'),
                    ),
                    h('span', { className: 'am-mono' }, item.sessionId.slice(0, 13)),
                    h('span', { style: { flex: 1 } }),
                    h(
                      'button',
                      {
                        className: 'am-btn am-btn-sm am-btn-ghost',
                        disabled: busy !== '',
                        onClick: () => void unbindSession(item.sessionId),
                      },
                      t('usageUnbind'),
                    ),
                  ),
                ),
              ),
        )
      } else if (tab === 'journal') {
        body = journalEditor
          ? h(
              'div',
              { className: 'am-split' },
              h(
                'div',
                { className: 'am-row' },
                h('button', { className: 'am-btn am-btn-sm am-btn-ghost', onClick: () => setJournalEditor(null) }, `← ${t('back')}`),
                h('span', { style: { flex: 1 } }),
                journalEditor.id !== ''
                  ? h('button', { className: 'am-btn am-btn-sm am-btn-danger', onClick: () => void journalDelete() }, t('deleteEntry'))
                  : null,
              ),
              h(Field, { label: t('entryTitle') }, h('input', {
                className: 'am-input',
                value: journalEditor.title,
                onChange: event => setJournalEditor({ ...journalEditor, title: event.target.value }),
              })),
              h(Field, { label: t('entryBody') }, h('textarea', {
                className: 'am-textarea',
                style: { minHeight: 280 },
                readOnly: journalEditor.id !== '',
                value: journalEditor.text,
                onChange: event => setJournalEditor({ ...journalEditor, text: event.target.value }),
              })),
              journalEditor.id === ''
                ? h(
                    'div',
                    { className: 'am-row am-row-end' },
                    h(
                      'button',
                      {
                        className: 'am-btn am-btn-primary',
                        disabled: busy !== '' || journalEditor.text.trim() === '',
                        onClick: () => void journalSave(),
                      },
                      t('saveEntry'),
                    ),
                  )
                : h('p', { className: 'am-note-dim' }, t('journalReadOnly')),
            )
          : h(
              'div',
              { className: 'am-split' },
              h('p', { className: 'am-note' }, t('journalHint')),
              h(
                'div',
                { className: 'am-row' },
                h('span', { style: { flex: 1 } }),
                h('button', { className: 'am-btn am-btn-sm am-btn-primary', onClick: () => journalNew() }, `+ ${t('newEntry')}`),
              ),
              journal.length === 0
                ? h('p', { className: 'am-note-dim' }, t('journalEmpty'))
                : h(
                    'div',
                    { className: 'am-list' },
                    journal.map(entry =>
                      h(
                        'button',
                        { key: entry.id, className: 'am-item', onClick: () => void journalOpen(entry.id) },
                        h('span', { className: 'am-item-title' }, entry.title || entry.id),
                        entry.preview ? h('span', { className: 'am-item-snippet' }, entry.preview) : null,
                        h(
                          'span',
                          { className: 'am-item-meta' },
                          h('span', { className: 'am-mono' }, entry.id),
                          h('span', null, ago(entry.at, locale)),
                        ),
                      ),
                    ),
                  ),
            )
      } else if (tab === 'handoff') {
        body = h(
          'div',
          { className: 'am-split' },
          h('p', { className: 'am-note' }, t('handoffHint')),
          h(
            'div',
            { className: 'am-card' },
            h(Switch, {
              checked: handoffInfo?.config?.enabled !== false,
              label: t('handoffEnabled'),
              hint: t('handoffEnabledHint'),
              disabled: busy !== '',
              onChange: checked => void saveHandoff({ enabled: checked }),
            }),
            h(Switch, {
              checked: handoffInfo?.config?.autoSwitch === true,
              label: t('autoSwitch'),
              hint: t('autoSwitchHint'),
              disabled: busy !== '',
              onChange: checked => void saveHandoff({ autoSwitch: checked }),
            }),
            handoffInfo?.capabilities?.startPrompt === true
              ? h(
                  'div',
                  { className: 'am-split' },
                  h(Field, { label: t('autoStartPrompt') }, h('textarea', {
                    className: 'am-textarea am-textarea-sm',
                    rows: 3,
                    value: handoffDraft.startupPrompt,
                    placeholder: t('autoStartPromptPlaceholder'),
                    disabled: busy !== '',
                    onChange: event => setHandoffDraft({ ...handoffDraft, startupPrompt: event.target.value }),
                  })),
                  h('p', { className: 'am-note-dim' }, t('autoStartPromptHint')),
                )
              : null,
            h(Field, { label: t('handoffThreshold') }, h('input', {
              className: 'am-input',
              type: 'number',
              min: 20000,
              step: 10000,
              value: handoffDraft.triggerTokens,
              onChange: event => setHandoffDraft({ ...handoffDraft, triggerTokens: Number(event.target.value) }),
            })),
            h(Field, { label: t('handoffRemindEvery') }, h('input', {
              className: 'am-input',
              type: 'number',
              min: 1,
              max: 20,
              step: 1,
              value: handoffDraft.remindEverySteps,
              onChange: event => setHandoffDraft({ ...handoffDraft, remindEverySteps: Number(event.target.value) }),
            })),
            h(Field, { label: t('handoffExport') }, h('input', {
              className: 'am-input',
              value: handoffDraft.exportDir,
              placeholder: t('handoffExportPlaceholder'),
              onChange: event => setHandoffDraft({ ...handoffDraft, exportDir: event.target.value }),
            })),
            h('p', { className: 'am-note-dim' }, t('handoffExportHint')),
            h(
              'div',
              { className: 'am-row am-row-end' },
              h(
                'button',
                {
                  className: 'am-btn am-btn-primary',
                  disabled: busy !== '',
                  onClick: () => void saveHandoff({
                    triggerTokens: handoffDraft.triggerTokens,
                    remindEverySteps: handoffDraft.remindEverySteps,
                    exportDir: handoffDraft.exportDir,
                    startupPrompt: handoffDraft.startupPrompt,
                  }),
                },
                t('handoffSave'),
              ),
            ),
          ),
          h('span', { className: 'am-label' }, t('handoffSessions')),
          (handoffInfo?.sessions ?? []).length === 0
            ? h('p', { className: 'am-note-dim' }, t('handoffNoSessions'))
            : h(
                'div',
                { className: 'am-list' },
                handoffInfo.sessions.map(session =>
                  h(
                    'div',
                    { key: session.sessionId, className: 'am-card' },
                    h(
                      'div',
                      { className: 'am-row' },
                      h('span', { className: 'am-usage-title' }, session.title || t('untitled')),
                      h('span', { className: 'am-tag' }, t(`stage.${session.stage}`)),
                      session.armed
                        ? h('span', { className: 'am-tag', title: t('handoffArmedHint') }, t('handoffArmed'))
                        : null,
                      session.checkpoint
                        ? h(
                            'span',
                            { className: 'am-tag am-mono', title: session.exported ? `${t('handoffExported')}: ${session.exported}` : '' },
                            `${t('handoffCheckpoint')} ${session.checkpoint}`,
                          )
                        : null,
                      h('span', { style: { flex: 1 } }),
                      handoffInfo?.capabilities?.arm === true && session.stage === 'settled'
                        ? h(
                            'button',
                            {
                              className: 'am-btn am-btn-sm am-btn-primary',
                              title: t('handoffContinueHint'),
                              disabled: busy !== '',
                              onClick: () => void continueHandoff(session.sessionId),
                            },
                            t('handoffContinue'),
                          )
                        : null,
                      session.stage === 'requested' || session.stage === 'settled'
                        ? h(
                            'button',
                            {
                              className: 'am-btn am-btn-sm am-btn-ghost',
                              disabled: busy !== '',
                              onClick: () => void resetHandoff(session.sessionId),
                            },
                            t('handoffReset'),
                          )
                        : null,
                    ),
                    h(
                      'div',
                      { className: 'am-row' },
                      h('span', { className: 'am-mono' }, session.sessionId.slice(0, 13)),
                      h(
                        'span',
                        { className: 'am-note-dim' },
                        `${Number(session.tokens).toLocaleString('en-US')} / ${Number(handoffInfo.config.triggerTokens).toLocaleString('en-US')}`,
                      ),
                      session.agentId ? h('span', { className: 'am-tag' }, session.agentId) : null,
                    ),
                  ),
                ),
              ),
        )
      } else if (tab === 'sessions') {
        body = h(
          'div',
          { className: 'am-split' },
          h('p', { className: 'am-note' }, t('sessionsHint')),
          h(
            'div',
            { className: 'am-card' },
            h(
              Field,
              { label: t('sessionsWorkspace') },
              h(
                'div',
                { className: 'am-row' },
                h(
                  'select',
                  {
                    className: 'am-input',
                    style: { flex: '1 1 200px', width: 'auto' },
                    value: sessionsWorkspace,
                    disabled: busy !== '' || (sessionsInfo.workspaces ?? []).length === 0,
                    onChange: event => {
                      const next = event.target.value
                      setSessionsWorkspace(next)
                      if (data?.capabilities?.sessions === true) void switchWorkspace(next)
                    },
                  },
                  (sessionsInfo.workspaces ?? []).map(item =>
                    h('option', { key: item.id, value: item.id }, item.title || item.path),
                  ),
                ),
                h(
                  'button',
                  {
                    className: 'am-btn am-btn-sm am-btn-primary',
                    disabled: busy !== '' || sessionsWorkspace === '',
                    onClick: () => void newBoundSession(),
                  },
                  t('sessionsNew'),
                ),
              ),
            ),
          ),
          h('span', { className: 'am-label' }, t('sessionsTitle')),
          (sessionsInfo.sessions ?? []).length === 0
            ? h('p', { className: 'am-note-dim' }, t('sessionsEmpty'))
            : h(
                'div',
                { className: 'am-list' },
                sessionsInfo.sessions.map(session => {
                  const level = session.archive === 'strong' ? 'strong' : session.archive === 'weak' ? 'weak' : ''
                  const canArchive = data?.capabilities?.archive === true
                  return h(
                    'div',
                    { key: session.sessionId, className: `am-card${level === 'strong' ? ' is-strong' : ''}` },
                    h(
                      'div',
                      { className: 'am-row' },
                      h('span', { className: 'am-usage-title' }, session.title || t('untitled')),
                      h('span', { className: 'am-tag' }, session.workspaceTitle || t('sessionsNoWorkspace')),
                      session.running ? h('span', { className: 'am-tag' }, t('running')) : null,
                      level !== ''
                        ? h(
                            'span',
                            { className: 'am-tag', title: t(level === 'weak' ? 'archiveWeakHint' : 'archiveStrongHint') },
                            t(level === 'weak' ? 'archiveWeak' : 'archiveStrong'),
                          )
                        : null,
                      h('span', { style: { flex: 1 } }),
                      level !== 'strong'
                        ? h(
                            'button',
                            {
                              className: 'am-btn am-btn-sm am-btn-primary',
                              disabled: busy !== '',
                              onClick: () => openBoundSession(session.sessionId),
                            },
                            t('sessionsOpen'),
                          )
                        : null,
                      canArchive && level === 'strong'
                        ? h(
                            'button',
                            {
                              className: 'am-btn am-btn-sm',
                              disabled: busy !== '',
                              onClick: () => void setArchive(session.sessionId, 'weak'),
                            },
                            t('archiveToWeak'),
                          )
                        : null,
                      canArchive && level === 'weak'
                        ? h(
                            'button',
                            {
                              className: 'am-btn am-btn-sm am-btn-ghost',
                              disabled: busy !== '',
                              onClick: () => void setArchive(session.sessionId, ''),
                            },
                            t('archiveCancel'),
                          )
                        : null,
                      canArchive && level === 'weak'
                        ? h(
                            'button',
                            {
                              className: 'am-btn am-btn-sm am-btn-ghost',
                              disabled: busy !== '',
                              onClick: () => void setArchive(session.sessionId, 'strong'),
                            },
                            t('archiveToStrong'),
                          )
                        : null,
                      canArchive && level === ''
                        ? h(
                            'button',
                            {
                              className: 'am-btn am-btn-sm am-btn-ghost',
                              title: t('archiveDoHint'),
                              disabled: busy !== '',
                              onClick: () => void setArchive(session.sessionId, 'weak'),
                            },
                            t('archiveDo'),
                          )
                        : null,
                      level === ''
                        ? h(
                            'button',
                            {
                              className: 'am-btn am-btn-sm am-btn-ghost',
                              disabled: busy !== '',
                              onClick: () => void unbindBoundSession(session.sessionId),
                            },
                            t('usageUnbind'),
                          )
                        : null,
                    ),
                    h(
                      'div',
                      { className: 'am-row' },
                      h('span', { className: 'am-mono' }, session.sessionId.slice(0, 13)),
                      session.updatedAt ? h('span', { className: 'am-note-dim' }, ago(session.updatedAt, locale)) : null,
                      session.visible === false && session.archive === ''
                        ? h('span', { className: 'am-note-dim' }, t('sessionsGone'))
                        : null,
                    ),
                  )
                }),
              ),
        )
      } else if (tab === 'recall') {
        const sourceLabel = src => t(`recallSrc${src.charAt(0).toUpperCase()}${src.slice(1)}`)
        body = h(
          'div',
          { className: 'am-split' },
          h(
            'div',
            { className: 'am-row' },
            h('span', { className: 'am-label' }, t('recall')),
            h('span', { className: 'am-badge' }, '2.0 alpha'),
            h('span', { style: { flex: 1 } }),
            h(
              'button',
              { className: 'am-btn am-btn-sm', disabled: busy !== '', onClick: () => void rebuildIndex() },
              t('recallRebuild'),
            ),
          ),
          h('p', { className: 'am-note' }, t('recallHint')),
          h(
            'div',
            { className: 'am-row' },
            h('input', {
              className: 'am-input',
              style: { flex: 1, minWidth: 200 },
              value: recallQuery,
              placeholder: t('recallPlaceholder'),
              onChange: event => setRecallQuery(event.target.value),
              onKeyDown: event => {
                if (event.key === 'Enter') void runRecall()
              },
            }),
            h(
              'button',
              {
                className: 'am-btn am-btn-sm am-btn-primary',
                disabled: busy !== '' || recallQuery.trim() === '',
                onClick: () => void runRecall(),
              },
              t('recallSearch'),
            ),
            recallData === null
              ? null
              : h(
                  'button',
                  {
                    className: 'am-btn am-btn-sm am-btn-ghost',
                    onClick: () => {
                      setRecallQuery('')
                      setRecallData(null)
                      setRecallDetail(null)
                    },
                  },
                  t('recallClear'),
                ),
          ),
          h(
            'div',
            { className: 'am-row' },
            h(
              'select',
              {
                className: 'am-input',
                style: { width: 150 },
                value: recallSource,
                onChange: event => setRecallSource(event.target.value),
              },
              h('option', { value: '' }, t('recallAll')),
              h('option', { value: 'journal' }, t('recallSrcJournal')),
              h('option', { value: 'log' }, t('recallSrcLog')),
              h('option', { value: 'knowledge' }, t('recallSrcKnowledge')),
              h('option', { value: 'session' }, t('recallSrcSession')),
            ),
            h('input', {
              className: 'am-input',
              style: { width: 170 },
              type: 'date',
              value: recallSince,
              onChange: event => setRecallSince(event.target.value),
            }),
            h('span', { className: 'am-note-dim' }, t('recallSince')),
            h('span', { style: { flex: 1 } }),
            recallData === null
              ? null
              : h('span', { className: 'am-note-dim' }, `${recallData.total} ${t('recallUnit')}`),
          ),
          indexData === null
            ? null
            : h(
                'div',
                { className: 'am-card' },
                h(
                  'div',
                  { className: 'am-row' },
                  h('span', { className: 'am-label' }, t('recallIndex')),
                  h(
                    'span',
                    { className: 'am-note-dim' },
                    indexData.builtAt === '' ? '—' : `${t('recallBuilt')} ${ago(indexData.builtAt, locale)}`,
                  ),
                  h('span', { style: { flex: 1 } }),
                  h('span', { className: 'am-note-dim' }, `${indexData.total ?? 0} ${t('recallIndexTotal')}`),
                ),
                h(
                  'div',
                  { className: 'am-note-dim' },
                  Object.entries(indexData.sources ?? {})
                    .map(([key, count]) => `${key} ${count}`)
                    .join(' · ') || t('recallEmpty'),
                ),
              ),
          recallData === null
            ? h('p', { className: 'am-note-dim' }, t('recallEmpty'))
            : recallData.results.length === 0
              ? h('p', { className: 'am-note-dim' }, t('recallNoResult'))
              : h(
                  'div',
                  { className: 'am-list' },
                  recallData.results.map(hit =>
                    h(
                      'div',
                      { key: `${hit.src}:${hit.id}`, className: 'am-recall-hit' },
                      h(
                        'button',
                        { className: 'am-item', onClick: () => void openRecallHit(hit) },
                        h(
                          'span',
                          { className: 'am-item-title' },
                          hit.title || hit.id,
                          h('span', { className: 'am-tag' }, sourceLabel(hit.src)),
                          hit.via === 'lexical'
                            ? null
                            : h(
                                'span',
                                { className: 'am-tag' },
                                t(`recallVia${hit.via.charAt(0).toUpperCase()}${hit.via.slice(1)}`),
                              ),
                        ),
                        h('span', { className: 'am-item-snippet' }, hit.preview || '—'),
                        h(
                          'span',
                          { className: 'am-item-meta' },
                          `${ago(hit.at, locale)} · ${t('recallScore')} ${hit.score}`,
                        ),
                      ),
                      recallDetail !== null && recallDetail.id === hit.id && recallDetail.src === hit.src
                        ? h(
                            'div',
                            { className: 'am-recall-detail' },
                            recallDetail.why === null || recallDetail.why === undefined
                              ? null
                              : h('div', { className: 'am-note-dim' }, `${t('recallWhy')} ${recallDetail.why.hub} · ${recallDetail.why.edge} ${recallDetail.why.weight}`),
                            recallDetail.sessionId
                              ? h(
                                  'button',
                                  {
                                    className: 'am-btn am-btn-sm am-btn-ghost',
                                    onClick: () => void goToSession(recallDetail.sessionId),
                                  },
                                  t('recallGoSession'),
                                )
                              : null,
                            recallDetail.text || '—',
                          )
                        : null,
                    ),
                  ),
                ),
          h('p', { className: 'am-note-dim' }, t('recallExpandSoon')),
        )
      } else if (tab === 'knowledge') {
        body = editor
          ? h(
              'div',
              { className: 'am-split' },
              h(
                'div',
                { className: 'am-row' },
                h('button', { className: 'am-btn am-btn-sm am-btn-ghost', onClick: () => setEditor(null) }, `← ${t('back')}`),
                h('span', { style: { flex: 1 } }),
                editor.id !== ''
                  ? h('button', { className: 'am-btn am-btn-sm am-btn-danger', onClick: () => void deleteEntry() }, t('deleteEntry'))
                  : null,
              ),
              h(Field, { label: t('entryTitle') }, h('input', {
                className: 'am-input',
                value: editor.title,
                onChange: event => setEditor({ ...editor, title: event.target.value }),
              })),
              h(Field, { label: t('entryTags') }, h('input', {
                className: 'am-input',
                value: editor.tags,
                placeholder: 'path, build, windows',
                onChange: event => setEditor({ ...editor, tags: event.target.value }),
              })),
              h(Field, { label: t('entryBody') }, h('textarea', {
                className: 'am-textarea',
                style: { minHeight: 300 },
                value: editor.content,
                onChange: event => setEditor({ ...editor, content: event.target.value }),
              })),
              h(
                'div',
                { className: 'am-row am-row-end' },
                h(
                  'button',
                  {
                    className: 'am-btn am-btn-primary',
                    disabled: busy !== '' || editor.content.trim() === '',
                    onClick: () => void saveEntry(),
                  },
                  t('saveEntry'),
                ),
              ),
            )
          : h(
              'div',
              { className: 'am-split' },
              h(
                'div',
                { className: 'am-row' },
                h('span', { className: 'am-label' }, t('kbTitle')),
                h('span', { className: 'am-badge' }, t('shared')),
                h('span', { className: 'am-note-dim' }, `${data.knowledgeCount ?? list.length} ${t('entryCount')}`),
              ),
              h('p', { className: 'am-note' }, t('kbHint')),
              h(
                'div',
                { className: 'am-row' },
                h('input', {
                  className: 'am-input',
                  style: { flex: 1, minWidth: 180 },
                  value: query,
                  placeholder: t('searchPlaceholder'),
                  onChange: event => setQuery(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter') void search()
                  },
                }),
                h(
                  'button',
                  { className: 'am-btn am-btn-sm', disabled: busy !== '', onClick: () => void search() },
                  t('search'),
                ),
                results === null
                  ? null
                  : h(
                      'button',
                      {
                        className: 'am-btn am-btn-sm am-btn-ghost',
                        onClick: () => {
                          setQuery('')
                          setResults(null)
                        },
                      },
                      t('clear'),
                    ),
                h('span', { style: { flex: 1 } }),
                h(
                  'button',
                  {
                    className: 'am-btn am-btn-sm am-btn-primary',
                    onClick: () => setEditor({ id: '', title: '', tags: '', content: '' }),
                  },
                  `+ ${t('newEntry')}`,
                ),
              ),
              list.length === 0
                ? h(
                    'p',
                    { className: 'am-note-dim' },
                    results === null ? t('kbEmpty') : t('noResult'),
                  )
                : h(
                    'div',
                    { className: 'am-list' },
                    list.map(entry =>
                      h(
                        'button',
                        { key: entry.id, className: 'am-item', onClick: () => void openEntry(entry.id) },
                        h(
                          'span',
                          { className: 'am-item-title' },
                          entry.title || entry.id,
                          (entry.tags ?? []).map(tag => h('span', { key: tag, className: 'am-tag' }, tag)),
                        ),
                        entry.snippet ? h('span', { className: 'am-item-snippet' }, entry.snippet) : null,
                        h(
                          'span',
                          { className: 'am-item-meta' },
                          entry.agent
                            ? h('span', { className: 'am-tag' }, `${t('contributor')} ${entry.agent}`)
                            : null,
                          h('span', { className: 'am-mono' }, entry.id),
                          entry.updated ? h('span', null, `${t('updatedAt')} ${ago(entry.updated, locale)}`) : null,
                        ),
                      ),
                    ),
                  ),
            )
      } else {
        body = h(
          'div',
          { className: 'am-split' },
          h(
            'div',
            { className: 'am-card' },
            h('span', { className: 'am-label' }, t('dirTitle')),
            h('p', { className: 'am-note' }, t('dirHint')),
            h('div', { className: 'am-path' }, `${t('dirDefault')}: ${data.knowledgeDir}`),
            h('input', {
              className: 'am-input',
              value: dirDraft,
              placeholder: t('dirPlaceholder'),
              onChange: event => setDirDraft(event.target.value),
            }),
            h(
              'div',
              { className: 'am-row am-row-end' },
              h(
                'button',
                { className: 'am-btn am-btn-sm', disabled: busy !== '', onClick: () => void saveDir() },
                t('dirSave'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'am-card' },
            h(Switch, {
              checked: data.hideBoundSessions !== false,
              label: t('hideBound'),
              hint: t('hideBoundHint'),
              disabled: busy !== '',
              onChange: checked => void saveHideBound(checked),
            }),
            h('div', { style: { height: 12 } }),
            h(Switch, {
              checked: data.transcripts !== false,
              label: t('transcripts'),
              hint: t('transcriptsHint'),
              disabled: busy !== '',
              onChange: checked => void saveTranscripts(checked),
            }),
          ),
          h(
            'div',
            { className: 'am-card am-danger-card' },
            h('span', { className: 'am-label' }, t('danger')),
            h('p', { className: 'am-note-dim' }, t('deleteVaultHint')),
            h(
              'div',
              { className: 'am-row am-row-end' },
              h(
                'button',
                { className: 'am-btn am-btn-sm am-btn-danger', disabled: busy !== '', onClick: () => void deleteVault() },
                t('deleteVault'),
              ),
            ),
          ),
        )
      }

      const main = h(
        'section',
        { className: 'am-main' },
          h(
            'header',
            { className: 'am-head' },
            h(
              'div',
              { className: 'am-head-main' },
              h('h2', { className: 'am-head-name' }, vault ? vault.name : t('title')),
              h('p', { className: 'am-head-sub' }, vault && vault.description ? vault.description : t('subtitle')),
            ),
            vault
              ? h(
                  'div',
                  { className: 'am-head-actions' },
                  h(Switch, {
                    checked: vault.id === data.activeVault,
                    label: t('inherit'),
                    hint: t('inheritHint'),
                    disabled: busy !== '',
                    onChange: checked => void toggleInherit(checked),
                  }),
                )
              : null,
          ),
          vault
            ? h(
                'nav',
                { className: 'am-tabs' },
                ['memory', 'recall', 'sessions', 'knowledge', 'journal', 'handoff', 'settings']
                  .filter(key => key !== 'sessions' || data?.capabilities?.sessions === true)
                  .map(key =>
                  h(
                    'button',
                    {
                      key,
                      className: `am-tab${tab === key ? ' is-active' : ''}`,
                      onClick: () => {
                        setTab(key)
                        if (key !== 'knowledge') {
                          setEditor(null)
                          setResults(null)
                        }
                      },
                    },
                    key === 'sessions' ? t('sessionsTab') : t(key),
                  ),
                ),
              )
            : null,
          failure !== '' && data !== null ? h('div', { style: { padding: '0 26px' } }, h('p', { className: 'am-error' }, failure)) : null,
          h('div', { className: 'am-body' }, body),
      )

      const roomMain =
        view !== 'rooms' || roomData === null
          ? null
          : h(
              'section',
              { className: 'am-main' },
              h(
                'header',
                { className: 'am-head' },
                h(
                  'div',
                  { className: 'am-head-main' },
                  h('h2', { className: 'am-head-name' }, roomData.room.name),
                  h(
                    'p',
                    { className: 'am-head-sub' },
                    `${roomData.room.members.length} ${t('membersUnit')} · ${roomData.total} ${t('messagesUnit')}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'am-head-actions' },
                  h('button', { className: 'am-btn am-btn-sm am-btn-danger', onClick: () => void deleteRoom() }, t('deleteRoom')),
                ),
              ),
              h(
                'div',
                { className: 'am-room-members' },
                h('span', { className: 'am-label' }, t('roomMembers')),
                data.vaults.map(item =>
                  h(
                    'button',
                    {
                      key: item.id,
                      className: `am-member${roomData.room.members.includes(item.id) ? ' is-in' : ''}`,
                      onClick: () => void toggleMember(item.id),
                    },
                    roomData.room.members.includes(item.id) ? `✓ ${item.name}` : `+ ${item.name}`,
                  ),
                ),
              ),
              h(
                'div',
                { className: 'am-room-flow' },
                roomData.messages.length === 0
                  ? h('p', { className: 'am-note-dim' }, t('roomEmpty'))
                  : roomData.messages.map(message =>
                      h(
                        'div',
                        { key: message.id, className: 'am-msg' },
                        h(
                          'div',
                          { className: 'am-msg-head' },
                          h('span', { className: 'am-msg-from' }, message.from.name || message.from.id),
                          h('span', { className: 'am-note-dim' }, ago(message.at, locale)),
                        ),
                        h('div', { className: 'am-msg-text' }, message.text),
                      ),
                    ),
              ),
              h(
                'div',
                { className: 'am-room-compose' },
                h('textarea', {
                  className: 'am-textarea',
                  style: { minHeight: 64, maxHeight: 160 },
                  value: roomDraft,
                  placeholder: t('roomPlaceholder'),
                  onChange: event => setRoomDraft(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void sendRoom()
                    }
                  },
                }),
                h(
                  'div',
                  { className: 'am-row am-row-end' },
                  h(
                    'button',
                    { className: 'am-btn am-btn-primary', disabled: busy !== '' || roomDraft.trim() === '', onClick: () => void sendRoom() },
                    t('send'),
                  ),
                ),
              ),
            )

      return h('div', { className: 'am-root' }, side, view === 'rooms' ? roomMain : main)
    }

    // ── new-conversation agent picker ───────────────────────────────────────
    // The New Session row already knows its session id, so the choice is written
    // straight onto that conversation instead of a global switch.
    function HeroAgentPicker(props) {
      const t = useLocale(props)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [vaults, setVaults] = useState(null)
      const [value, setValue] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        if (sessionId === '') return undefined
        let alive = true
        request('/state')
          .then(payload => {
            if (!alive) return
            const list = payload.state.vaults ?? []
            setVaults(list)
            const bound = (payload.state.bindings ?? []).find(item => item.sessionId === sessionId)
            setValue(bound ? bound.agentId : '')
          })
          .catch(() => {
            if (alive) setVaults([])
          })
        return () => {
          alive = false
        }
      }, [sessionId])

      if (sessionId === '' || vaults === null || vaults.length === 0) return null

      const change = next => {
        setValue(next)
        setBusy(true)
        request('/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'binding.set', args: { sessionId, agentId: next } }),
        })
          .catch(() => {})
          .then(() => setBusy(false))
      }

      return h(
        'label',
        { className: 'am-hero', title: t('inheritHint') },
        h('span', null, t('binding')),
        h(
          'select',
          { value, disabled: busy, onChange: event => change(event.target.value) },
          h('option', { value: '' }, t('noAgent')),
          vaults.map(item => h('option', { key: item.id, value: item.id }, item.name)),
        ),
      )
    }

    // ── sidebar icon ────────────────────────────────────────────────────────
    function Icon(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      const stroke = props.active ? 'var(--dsw-alias-state-business-primary)' : 'currentColor'
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 12, cy: 8, r: 3.2 }),
        h('path', { d: 'M5.5 20c0-3.2 2.9-5.2 6.5-5.2s6.5 2 6.5 5.2' }),
        h('path', { d: 'M17.4 5.2h3.2M17.4 8h3.2M17.4 10.8h3.2' }),
      )
    }

    // ── activation ──────────────────────────────────────────────────────────
    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'agent-memory: dictionaries')

      ctx.effect(() => {
        const unsubscribe = ctx.locale.subscribe(() => {
          for (const listener of localeListeners) listener()
        })
        return unsubscribe
      }, 'agent-memory: locale notifications')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'agent-memory')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'agent-memory: styles')

      // Bound conversations live under their agent, not the workspace list.
      // DSH offers no filter seat for that list, so hide its rows by session id
      // and mount an agent-shaped section right above the workspace browser.
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'agent-memory-hide')
        document.head.appendChild(style)
        let stopped = false
        let applied = ''
        let sectionOpen = true
        let lastAgents = []
        let bannerSessionId = ''
        const autoSwitched = new Set()
        let observer = null
        let observedRoot = null
        const collapsed = new Set()
        let lastListSignature = ''
        let searchQuery = ''
        let searchOpen = false
        let sortMode = 'recent'
        let showArchived = true
        let viewOpen = false
        /** Only a checkpoint written within this window is worth an auto switch. */
        const AUTO_SWITCH_FRESH_MS = 30 * 60 * 1000
        const prefsKey = 'agent-memory:sidebar'
        try {
          const saved = JSON.parse(window.localStorage.getItem(prefsKey) ?? '{}')
          if (saved?.sort === 'recent' || saved?.sort === 'name') sortMode = saved.sort
          if (typeof saved?.showArchived === 'boolean') showArchived = saved.showArchived
          if (typeof saved?.sectionOpen === 'boolean') sectionOpen = saved.sectionOpen
        } catch {
          /* storage can be unavailable in hardened compositions */
        }
        const escape = value =>
          String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
        const savePrefs = () => {
          try {
            window.localStorage.setItem(prefsKey, JSON.stringify({ sort: sortMode, showArchived, sectionOpen }))
          } catch {
            /* ignore */
          }
        }
        const openCreateAgent = () => {
          const layout = ctx.get('layout')
          if (layout !== undefined && typeof layout.selectPanel === 'function') {
            try {
              layout.selectPanel('agent-memory')
            } catch {
              /* panel id moved in a newer shell */
            }
          }
          if (typeof sidebarBridge.onRequestCreateAgent === 'function') sidebarBridge.onRequestCreateAgent()
          else sidebarBridge.createAgent = true
        }
        // Same glyph language as the shell: 14px stroked icons, no emoji.
        const ICON = {
          search:
            '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.6 10.6 13.7 13.7"/></svg>',
          view:
            '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.5 5h11M2.5 11h11"/><circle cx="10.5" cy="5" r="1.7"/><circle cx="5.5" cy="11" r="1.7"/></svg>',
          add:
            '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
          chevron:
            '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
        }

        // ── right-click menu, multi-select and the actions on them ───────────
        // Selection lives outside the DOM: the section repaints on every sync
        // and every filter change, and a lost selection would lose the menu's
        // target halfway through.
        const ctxSelected = new Set()
        let ctxAgentId = ''
        let ctxAnchor = { agentId: '', sessionId: '' }
        let ctxMenu = null
        let ctxDetach = null
        let ctxToast = null
        let ctxToastTimer = 0
        let visibleSessions = []

        const postOp = (op, args) =>
          request('/op', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op, args }),
          })

        const showToast = (text, failed = false) => {
          if (ctxToast !== null) ctxToast.remove()
          window.clearTimeout(ctxToastTimer)
          ctxToast = document.createElement('div')
          ctxToast.className = `am-toast-bar${failed ? ' is-failed' : ''}`
          ctxToast.textContent = text
          document.body.appendChild(ctxToast)
          ctxToastTimer = window.setTimeout(() => {
            ctxToast?.remove()
            ctxToast = null
          }, 2400)
        }

        const closeContextMenu = () => {
          if (ctxDetach !== null) {
            ctxDetach()
            ctxDetach = null
          }
          if (ctxMenu !== null) {
            ctxMenu.remove()
            ctxMenu = null
          }
        }

        /** `items` are { head } | { separator: true } | { label, hint?, disabled?, run }. */
        const openContextMenu = (event, items) => {
          closeContextMenu()
          const menu = document.createElement('div')
          menu.className = 'am-ctx'
          menu.setAttribute('role', 'menu')
          menu.innerHTML = items
            .map((item, index) => {
              if (item.separator === true) return '<div class="am-ctx-sep" role="separator"></div>'
              if (typeof item.head === 'string') return `<div class="am-ctx-head">${escape(item.head)}</div>`
              return (
                `<button type="button" class="am-ctx-item" role="menuitem" data-ctx="${index}"${item.disabled === true ? ' disabled' : ''}>` +
                `<span class="am-ctx-label">${escape(item.label)}</span>` +
                (item.hint ? `<span class="am-ctx-hint">${escape(item.hint)}</span>` : '') +
                `</button>`
              )
            })
            .join('')
          document.body.appendChild(menu)
          // Measure before showing so the first paint never flashes at 0,0.
          menu.style.visibility = 'hidden'
          const box = menu.getBoundingClientRect()
          const left = Math.min(Math.max(8, event.clientX), Math.max(8, window.innerWidth - box.width - 8))
          const top = Math.min(Math.max(8, event.clientY), Math.max(8, window.innerHeight - box.height - 8))
          menu.style.left = `${left}px`
          menu.style.top = `${top}px`
          menu.style.visibility = ''
          menu.addEventListener('click', clicked => {
            const button = clicked.target.closest('[data-ctx]')
            if (button === null || button.disabled === true) return
            const item = items[Number(button.getAttribute('data-ctx'))]
            if (item === undefined || typeof item.run !== 'function') return
            closeContextMenu()
            item.run()
          })
          menu.addEventListener('keydown', key => {
            if (key.key !== 'ArrowDown' && key.key !== 'ArrowUp') return
            key.preventDefault()
            const buttons = [...menu.querySelectorAll('.am-ctx-item:not([disabled])')]
            if (buttons.length === 0) return
            const current = buttons.indexOf(document.activeElement)
            const next =
              key.key === 'ArrowDown' ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length
            buttons[next].focus()
          })
          const first = menu.querySelector('.am-ctx-item:not([disabled])')
          if (first !== null) {
            try {
              first.focus()
            } catch {
              /* focus can be refused while the sidebar repaints */
            }
          }
          ctxMenu = menu
          const onDown = down => {
            if (!menu.contains(down.target)) closeContextMenu()
          }
          const onKey = down => {
            if (down.key !== 'Escape') return
            down.preventDefault()
            closeContextMenu()
          }
          const onAway = () => closeContextMenu()
          window.addEventListener('pointerdown', onDown, true)
          window.addEventListener('keydown', onKey, true)
          window.addEventListener('resize', onAway)
          window.addEventListener('blur', onAway)
          document.addEventListener('scroll', onAway, true)
          ctxDetach = () => {
            window.removeEventListener('pointerdown', onDown, true)
            window.removeEventListener('keydown', onKey, true)
            window.removeEventListener('resize', onAway)
            window.removeEventListener('blur', onAway)
            document.removeEventListener('scroll', onAway, true)
          }
        }

        const agentNameOf = agentId => lastAgents.find(agent => agent.agentId === agentId)?.name ?? ''
        const levelOfSession = sessionId => {
          for (const agent of lastAgents) {
            const found = agent.sessions.find(item => item.sessionId === sessionId)
            if (found !== undefined) return found.archive ?? ''
          }
          return ''
        }

        const openSession = sessionId => {
          const ui = ctx.get('uiWorkspace')
          if (sessionId !== '' && ui !== undefined && typeof ui.openSession === 'function') ui.openSession(sessionId)
        }

        const runArchive = async level => {
          const ids = [...ctxSelected]
          if (ids.length === 0) return
          const results = await Promise.allSettled(ids.map(sessionId => postOp('archive.set', { sessionId, level })))
          const failed = results.find(result => result.status === 'rejected')
          if (failed !== undefined) {
            showToast(`${t('ctxFailed')}：${String(failed.reason?.message ?? failed.reason ?? '')}`, true)
          } else {
            showToast(level === 'strong' ? t('ctxDoneStrong') : level === 'weak' ? t('ctxDoneArchive') : t('ctxDoneUnarchive'))
          }
          // Archiving from here would otherwise make the row vanish and leave the
          // user with no visible way back, so reveal archived rows once.
          if (level === 'weak' && !showArchived) {
            showArchived = true
            savePrefs()
          }
          ctxSelected.clear()
          ctxAnchor = { agentId: '', sessionId: '' }
          await sync()
        }

        const createSessionForAgent = async agentId => {
          const agent = lastAgents.find(item => item.agentId === agentId)
          const workspaceId =
            agent?.sessions.find(item => typeof item.workspaceId === 'string' && item.workspaceId !== '')?.workspaceId ?? ''
          try {
            const payload = await postOp('agent.newSession', { id: agentId, workspaceId })
            const sessionId = String(payload?.value?.sessionId ?? '')
            if (sessionId !== '') openSession(sessionId)
            showToast(t('ctxDoneNew'))
            await sync()
          } catch (error) {
            showToast(`${t('ctxFailed')}：${String(error?.message ?? error)}`, true)
          }
        }

        const openSessionMenu = event => {
          const ids = [...ctxSelected]
          const levels = ids.map(levelOfSession)
          const agentId = ctxAnchor.agentId
          const name = agentNameOf(agentId)
          const items = []
          if (ids.length > 1) items.push({ head: `${t('ctxSelected')} ${ids.length} ${t('ctxUnit')}` })
          items.push({ label: t('ctxOpen'), run: () => openSession(ids[0] ?? '') })
          items.push({ separator: true })
          items.push({
            label: t('ctxArchive'),
            hint: t('ctxArchiveHint'),
            disabled: levels.every(level => level !== ''),
            run: () => void runArchive('weak'),
          })
          items.push({
            label: t('ctxToStrong'),
            hint: t('ctxToStrongHint'),
            disabled: levels.every(level => level === 'strong'),
            run: () => void runArchive('strong'),
          })
          items.push({
            label: t('ctxUnarchive'),
            hint: t('ctxUnarchiveHint'),
            disabled: levels.every(level => level === ''),
            run: () => void runArchive(''),
          })
          if (agentId !== '') {
            items.push({ separator: true })
            items.push({
              label: name === '' ? t('ctxNewSession') : `${t('ctxNewSession')} · ${name}`,
              hint: t('ctxNewSessionHint'),
              run: () => void createSessionForAgent(agentId),
            })
          }
          openContextMenu(event, items)
        }

        const openAgentMenu = event => {
          const agentId = ctxAgentId
          const agent = lastAgents.find(item => item.agentId === agentId)
          if (agent === undefined) return
          const open = !collapsed.has(agentId)
          openContextMenu(event, [
            { head: agent.name },
            { label: t('ctxNewSession'), hint: t('ctxNewSessionHint'), run: () => void createSessionForAgent(agentId) },
            { separator: true },
            {
              label: open ? t('ctxCollapse') : t('ctxExpand'),
              run: () => {
                if (open) collapsed.add(agentId)
                else collapsed.delete(agentId)
                const host = document.getElementById('am-sidebar-agents')
                if (host !== null) renderSection(host)
              },
            },
          ])
        }

        /** Ctrl/Cmd toggles one row; Shift extends from the last anchor inside one agent. */
        const extendSelection = (sessionId, agentId, event) => {
          if (event.shiftKey && ctxAnchor.agentId === agentId && ctxAnchor.sessionId !== '') {
            const ids = visibleSessions.filter(item => item.agentId === agentId).map(item => item.sessionId)
            const from = ids.indexOf(ctxAnchor.sessionId)
            const to = ids.indexOf(sessionId)
            if (from !== -1 && to !== -1) {
              for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) ctxSelected.add(id)
              return
            }
          }
          if (ctxSelected.has(sessionId)) ctxSelected.delete(sessionId)
          else ctxSelected.add(sessionId)
          ctxAnchor = { agentId, sessionId }
        }

        /** Header, search and view menu are created once so typing keeps focus. */
        const ensureChrome = host => {
          if (host.dataset.chrome === '1') return
          host.dataset.chrome = '1'
          host.innerHTML =
            `<div class="am-side-agents-head">` +
            `<button type="button" class="am-side-agents-title" data-action="panel" title="${escape(t('sidebarPanel'))}">${escape(t('sidebarAgents'))}</button>` +
            `<span class="am-side-agents-count" title="0">0</span>` +
            `<span class="am-side-agents-actions">` +
            `<button type="button" class="am-side-icon-btn" data-action="search" title="${escape(t('sideSearch'))}" aria-label="${escape(t('sideSearch'))}">${ICON.search}</button>` +
            `<button type="button" class="am-side-icon-btn" data-action="view" title="${escape(t('sideView'))}" aria-label="${escape(t('sideView'))}">${ICON.view}</button>` +
            `<button type="button" class="am-side-icon-btn" data-action="add-agent" title="${escape(t('sideAddAgent'))}" aria-label="${escape(t('sideAddAgent'))}">${ICON.add}</button>` +
            `<button type="button" class="am-side-icon-btn am-side-agents-toggle is-open" data-action="toggle-section" title="${escape(t('sidebarCollapse'))}" aria-label="${escape(t('sidebarCollapse'))}">${ICON.chevron}</button>` +
            `</span>` +
            `<span class="am-side-search">` +
            `<input class="am-side-search-input" type="search" spellcheck="false" placeholder="${escape(t('sideSearch'))}" />` +
            `<button type="button" class="am-side-icon-btn" data-action="close-search" title="${escape(t('sideClose'))}" aria-label="${escape(t('sideClose'))}">×</button>` +
            `</span>` +
            `</div>` +
            `<div class="am-side-view" hidden>` +
            `<div class="am-side-view-title">${escape(t('sideSort'))}</div>` +
            `<button type="button" class="am-side-view-item" data-action="sort" data-sort="recent">${escape(t('sideSortRecent'))}</button>` +
            `<button type="button" class="am-side-view-item" data-action="sort" data-sort="name">${escape(t('sideSortName'))}</button>` +
            `<div class="am-side-view-title">${escape(t('sideShow'))}</div>` +
            `<button type="button" class="am-side-view-item" data-action="toggle-archived" aria-pressed="true">${escape(t('sideShowArchived'))}</button>` +
            `<div class="am-side-view-title">${escape(t('sideGroup'))}</div>` +
            `<button type="button" class="am-side-view-item" data-action="collapse-all">${escape(t('sideCollapseAll'))}</button>` +
            `<button type="button" class="am-side-view-item" data-action="expand-all">${escape(t('sideExpandAll'))}</button>` +
            `</div>` +
            `<div class="am-side-agents-list"></div>`
          const input = host.querySelector('.am-side-search-input')
          input.addEventListener('input', () => {
            searchQuery = input.value
            renderSection(host)
          })
          input.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return
            if (input.value !== '') {
              input.value = ''
              searchQuery = ''
            } else {
              searchOpen = false
            }
            renderSection(host)
          })
        }

        const renderSection = host => {
          ensureChrome(host)
          const query = searchQuery.trim().toLowerCase()
          const matches = session =>
            String(session.title ?? '').toLowerCase().includes(query) ||
            String(session.workspaceTitle ?? '').toLowerCase().includes(query)
          const visible = lastAgents
            .map(agent => {
              const nameHit = query !== '' && String(agent.name ?? '').toLowerCase().includes(query)
              const sessions = agent.sessions
                .filter(session => session.archive !== 'strong')
                .filter(session => showArchived || session.archive !== 'weak')
                .filter(session => query === '' || nameHit || matches(session))
              return { ...agent, sessions }
            })
            .filter(agent => agent.sessions.length > 0)
            .map(agent => ({
              ...agent,
              sessions: [...agent.sessions].sort(
                (left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0),
              ),
            }))
          if (visible.length === 0 && lastAgents.length === 0) {
            host.hidden = true
            return
          }
          host.hidden = false
          if (sortMode === 'name') visible.sort((left, right) => String(left.name).localeCompare(String(right.name), 'zh'))
          else {
            visible.sort(
              (left, right) =>
                (Number(right.sessions[0]?.updatedAt) || 0) - (Number(left.sessions[0]?.updatedAt) || 0),
            )
          }

          const total = visible.reduce((sum, agent) => sum + agent.sessions.length, 0)
          visibleSessions = visible.flatMap(agent =>
            agent.sessions.map(session => ({ sessionId: session.sessionId, agentId: agent.agentId })),
          )
          const count = host.querySelector('.am-side-agents-count')
          count.textContent = String(total)
          count.title = String(total)
          host.querySelector('.am-side-agents-head').classList.toggle('is-searching', searchOpen)
          const toggle = host.querySelector('.am-side-agents-toggle')
          toggle.classList.toggle('is-open', sectionOpen)
          toggle.title = sectionOpen ? t('sidebarCollapse') : t('sidebarExpand')
          host.classList.toggle('is-collapsed', !sectionOpen)
          const view = host.querySelector('.am-side-view')
          view.hidden = !viewOpen || searchOpen
          for (const item of view.querySelectorAll('[data-action="sort"]')) {
            item.classList.toggle('is-active', item.getAttribute('data-sort') === sortMode)
          }
          view.querySelector('[data-action="toggle-archived"]').classList.toggle('is-active', showArchived)

          const list = host.querySelector('.am-side-agents-list')
          const signature = JSON.stringify([
            sectionOpen,
            [...collapsed],
            query,
            sortMode,
            showArchived,
            [...ctxSelected].sort(),
            ctxAgentId,
            visible,
          ])
          if (signature === lastListSignature) return
          lastListSignature = signature
          if (visible.length === 0) {
            list.innerHTML = `<div class="am-side-empty">${escape(t('sideSearchEmpty'))}</div>`
            return
          }
          list.innerHTML = visible
            .map(agent => {
              const open = !collapsed.has(agent.agentId)
              const initial = Array.from(agent.name || '?')[0] || '?'
              const rows = open
                ? `<div class="am-side-sessions">` +
                  agent.sessions
                    .map(session => {
                      const weak = session.archive === 'weak'
                      const picked = ctxSelected.has(session.sessionId)
                      const state =
                        (session.running ? `<span class="am-side-session-dot" title="${escape(t('sideRunning'))}"></span>` : '') +
                        (weak ? `<span class="am-side-session-tag">${escape(t('sideArchived'))}</span>` : '')
                      return (
                        `<button type="button" class="am-side-session${weak ? ' is-weak' : ''}${picked ? ' is-selected' : ''}" data-action="open" data-session="${escape(session.sessionId)}" aria-selected="${picked ? 'true' : 'false'}" title="${escape(weak ? t('archiveWeakHint') : session.title || '')}">` +
                        `<span class="am-side-session-title">${escape(session.title || t('untitled'))}</span>` +
                        `<span class="am-side-session-meta">${escape(session.workspaceTitle || t('sessionsNoWorkspace'))}</span>` +
                        (state === '' ? '' : `<span class="am-side-session-state">${state}</span>`) +
                        `</button>`
                      )
                    })
                    .join('') +
                  `</div>`
                : ''
              return (
                `<div class="am-side-agent" data-agent="${escape(agent.agentId)}">` +
                `<button type="button" class="am-side-agent-row${ctxAgentId === agent.agentId ? ' is-selected' : ''}" data-action="toggle-agent" aria-selected="${ctxAgentId === agent.agentId ? 'true' : 'false'}">` +
                `<span class="am-side-agent-chevron${open ? ' is-open' : ''}">${ICON.chevron}</span>` +
                `<span class="am-side-agent-slot">${escape(initial)}</span>` +
                `<span class="am-side-agent-name">${escape(agent.name)}</span>` +
                `<span class="am-side-agent-count">${agent.sessions.length}</span>` +
                `</button>${rows}</div>`
              )
            })
            .join('')
        }

        const mount = () => {
          const area = document.querySelector('[class*="regionArea"]')
          const root = area?.parentElement
          if (!area || !root) return
          let host = document.getElementById('am-sidebar-agents')
          if (host === null) {
            host = document.createElement('div')
            host.id = 'am-sidebar-agents'
            host.className = 'am-side-agents'
            lastListSignature = ''
            host.addEventListener('click', event => {
              const target = event.target.closest('[data-action]')
              if (target === null) return
              const action = target.getAttribute('data-action')
              if (action === 'panel') {
                const layout = ctx.get('layout')
                if (layout !== undefined && typeof layout.selectPanel === 'function') {
                  try {
                    layout.selectPanel('agent-memory')
                  } catch {
                    /* panel id moved in a newer shell */
                  }
                }
              } else if (action === 'search') {
                searchOpen = true
                viewOpen = false
                renderSection(host)
                const input = host.querySelector('.am-side-search-input')
                if (input !== null) {
                  try {
                    input.focus()
                  } catch {
                    /* focus can be refused while the panel repaints */
                  }
                }
              } else if (action === 'close-search') {
                searchOpen = false
                searchQuery = ''
                const input = host.querySelector('.am-side-search-input')
                if (input !== null) input.value = ''
                renderSection(host)
              } else if (action === 'view') {
                viewOpen = !viewOpen
                renderSection(host)
              } else if (action === 'sort') {
                sortMode = target.getAttribute('data-sort') === 'name' ? 'name' : 'recent'
                viewOpen = false
                savePrefs()
                renderSection(host)
              } else if (action === 'toggle-archived') {
                showArchived = !showArchived
                savePrefs()
                renderSection(host)
              } else if (action === 'collapse-all') {
                for (const agent of lastAgents) collapsed.add(agent.agentId)
                viewOpen = false
                renderSection(host)
              } else if (action === 'expand-all') {
                collapsed.clear()
                viewOpen = false
                renderSection(host)
              } else if (action === 'add-agent') {
                openCreateAgent()
              } else if (action === 'toggle-section') {
                sectionOpen = !sectionOpen
                savePrefs()
                renderSection(host)
              } else if (action === 'toggle-agent') {
                const agentId = target.closest('[data-agent]')?.getAttribute('data-agent') ?? ''
                if (agentId === '') return
                closeContextMenu()
                ctxAgentId = ''
                if (collapsed.has(agentId)) collapsed.delete(agentId)
                else collapsed.add(agentId)
                renderSection(host)
              } else if (action === 'open') {
                const sessionId = target.getAttribute('data-session') ?? ''
                const agentId = target.closest('[data-agent]')?.getAttribute('data-agent') ?? ''
                closeContextMenu()
                if (event.ctrlKey || event.metaKey || event.shiftKey) {
                  ctxAgentId = ''
                  extendSelection(sessionId, agentId, event)
                  renderSection(host)
                  return
                }
                ctxSelected.clear()
                ctxAgentId = ''
                ctxAnchor = { agentId, sessionId }
                renderSection(host)
                openSession(sessionId)
              }
            })
            host.addEventListener('contextmenu', event => {
              const sessionRow = event.target.closest?.('.am-side-session') ?? null
              const agentRow = event.target.closest?.('.am-side-agent-row') ?? null
              if (sessionRow === null && agentRow === null) {
                // A stray right click inside our own section must not raise the
                // shell's menu for whatever row happens to sit behind it.
                event.preventDefault()
                event.stopPropagation()
                return
              }
              event.preventDefault()
              // The shell owns a context menu for its own session rows; ours is
              // a different row type, so it must not bubble into that one.
              event.stopPropagation()
              closeContextMenu()
              if (sessionRow !== null) {
                const sessionId = sessionRow.getAttribute('data-session') ?? ''
                const agentId = sessionRow.closest('[data-agent]')?.getAttribute('data-agent') ?? ''
                // Right-clicking inside an existing selection keeps it; anywhere
                // else it starts a new one on the row under the cursor.
                if (!ctxSelected.has(sessionId)) {
                  ctxSelected.clear()
                  ctxSelected.add(sessionId)
                }
                ctxAgentId = ''
                ctxAnchor = { agentId, sessionId }
                renderSection(host)
                openSessionMenu(event)
                return
              }
              const agentId = agentRow.closest('[data-agent]')?.getAttribute('data-agent') ?? ''
              if (agentId === '') return
              ctxSelected.clear()
              ctxAgentId = agentId
              ctxAnchor = { agentId: '', sessionId: '' }
              renderSection(host)
              openAgentMenu(event)
            })
          }
          if (host.parentElement !== root || host.nextElementSibling !== area) root.insertBefore(host, area)
          if (observedRoot !== root) {
            observer?.disconnect()
            observedRoot = root
            observer = new MutationObserver(() => {
              if (!root.contains(host)) root.insertBefore(host, area)
            })
            observer.observe(root, { childList: true })
          }
        }

        const sync = async () => {
          try {
            const payload = await request('/state')
            if (stopped) return
            const state = payload.state
            const ids = state?.hideBoundSessions === false ? [] : (state?.bindings ?? []).map(item => item.sessionId)
            const css = ids
              .filter(id => typeof id === 'string' && id !== '')
              .map(id => `[data-row-key="session:${id}"]{display:none!important}`)
              .join('')
            if (css !== applied) {
              style.textContent = css
              applied = css
            }
            if (state?.capabilities?.bound === true) {
              const boundPayload = await request('/op', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ op: 'bound.list', args: {} }),
              })
              if (stopped) return
              lastAgents = boundPayload.value?.agents ?? []
              mount()
              const host = document.getElementById('am-sidebar-agents')
              if (host !== null) renderSection(host)
            } else {
              lastAgents = []
              document.getElementById('am-sidebar-agents')?.remove()
            }
            // A read-only banner for the currently selected archived session.
            const selectedRow = document.querySelector('[data-row-key^="session:"][aria-selected="true"]')
            const selectedId = selectedRow === null ? '' : selectedRow.getAttribute('data-row-key').slice('session:'.length)
            const selectedLevel =
              selectedId === ''
                ? ''
                : lastAgents.flatMap(agent => agent.sessions).find(item => item.sessionId === selectedId)?.archive ?? ''
            let banner = document.getElementById('am-archive-banner')
            if (selectedLevel !== '') {
              bannerSessionId = selectedId
              if (banner === null) {
                banner = document.createElement('div')
                banner.id = 'am-archive-banner'
                banner.className = 'am-archive-banner'
                banner.addEventListener('click', event => {
                  if (event.target.closest('[data-action="unarchive"]') === null) return
                  void request('/op', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ op: 'archive.set', args: { sessionId: bannerSessionId, level: '' } }),
                  })
                    .then(() => {
                      banner.remove()
                      void sync()
                    })
                    .catch(() => {})
                })
                document.body.appendChild(banner)
              }
              if (banner.dataset.level !== selectedLevel) {
                banner.dataset.level = selectedLevel
                banner.innerHTML =
                  `<span>${escape(t('archiveBanner'))}</span>` +
                  `<button type="button" class="am-btn am-btn-sm am-btn-ghost" data-action="unarchive">${escape(t('archiveCancel'))}</button>`
              }
            } else if (banner !== null) {
              banner.remove()
            }
            // Auto handoff: any settled session that still holds a live handoff
            // intent gets a fresh conversation — no need to keep that session
            // selected. Skip the whole poll while any turn is running.
            if (state?.capabilities?.arm === true) {
              const statusPayload = await request('/op', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ op: 'handoff.status', args: {} }),
              })
              if (stopped) return
              const status = statusPayload.value
              if (status?.config?.autoSwitch === true) {
                const rows = Array.isArray(status.sessions) ? status.sessions : []
                const busy = rows.some(row => row.running === true)
                // A checkpoint is only worth handing off right after it was
                // written: the context just overflowed while the work was still
                // in flight. A session settled days ago is finished business.
                const fresh = row => {
                  const at = Date.parse(row?.settledAt ?? '')
                  return Number.isFinite(at) && Date.now() - at <= AUTO_SWITCH_FRESH_MS
                }
                const pick = rows
                  .filter(
                    row =>
                      row.stage === 'settled' &&
                      row.armed === true &&
                      row.running !== true &&
                      fresh(row) &&
                      !autoSwitched.has(row.sessionId),
                  )
                  .sort((left, right) => String(right.armedAt ?? '').localeCompare(String(left.armedAt ?? '')))[0]
                let ui
                try {
                  ui = ctx.get('uiWorkspace')
                } catch (error) {
                  console.log('[am-autoswitch] uiWorkspace lookup failed:', String(error))
                }
                if (!busy && pick !== undefined && ui !== undefined && typeof ui.startSession === 'function') {
                  autoSwitched.add(pick.sessionId)
                  const open = () => {
                    if (stopped) return
                    try {
                      // Deliberately no options: `startSession(workspaceId,
                      // { agentPreset })` takes DSH's *reuse-a-blank* path, which
                      // only prepares a draft — no Agent is created, so nothing
                      // inherits the binding and the startup instruction is never
                      // delivered. The Host inherits the preset on `agent/created`
                      // instead, before the first turn.
                      ui.startSession(pick.workspaceId || undefined)
                    } catch (error) {
                      console.log('[am-autoswitch] startSession threw:', String(error))
                      autoSwitched.delete(pick.sessionId)
                    }
                  }
                  if (status?.capabilities?.startPrompt === true) {
                    // Attach the startup instruction to the handoff intent
                    // first: the Host sends it after the new session inherits
                    // the binding, approval policy and model. A failed arm
                    // still opens the conversation, just without a message.
                    void request('/op', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ op: 'handoff.arm', args: { sessionId: pick.sessionId, autoStart: true } }),
                    })
                      .then(open, open)
                  } else {
                    open()
                  }
                }
              }
            }
          } catch {
            /* the API may not be mounted yet */
          }
        }
        void sync()
        const timer = setInterval(() => void sync(), 5000)
        return () => {
          stopped = true
          clearInterval(timer)
          observer?.disconnect()
          style.remove()
          document.getElementById('am-sidebar-agents')?.remove()
          document.getElementById('am-archive-banner')?.remove()
          closeContextMenu()
          window.clearTimeout(ctxToastTimer)
          ctxToast?.remove()
          ctxToast = null
        }
      }, 'agent-memory: hide bound sessions')

      const locale = () => {
        try {
          const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
          const value = snapshot?.active ?? ctx.locale?.locale
          return typeof value === 'string' ? value : document.documentElement.lang || 'en'
        } catch {
          return 'en'
        }
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'agent-memory', order: 20, label: () => t('nav') },
          props => h(Icon, props),
        ),
      )

      ctx.slots.inject('conversation.hero.options', () =>
        ctx.slots.register(
          { name: 'conversation.hero.options', id: 'agent-memory', order: 10, label: () => t('binding') },
          props => h(HeroAgentPicker, { ...props, t }),
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'agent-memory' }, props =>
          h(Panel, { ...props, t, getLocale: locale, uiWorkspace: () => ctx.get('uiWorkspace') }),
        ),
      )
    }

    // `uiWorkspace` is a client service: cordis only resolves a service from a
    // fiber that injects it. Without this entry `ctx.get('uiWorkspace')` throws
    // and both the auto-switch poll and the panel's `uiWorkspace` prop fall into
    // their catch blocks — so the switch never happens at all.
    return { inject: ['slots', 'locale', 'uiWorkspace'], name: 'agent-memory', apply }
  },
})
