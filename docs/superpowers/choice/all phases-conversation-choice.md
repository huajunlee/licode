# LICode 选择文档

**日期**: 2026-06-01
**状态**: 已确认
**范围**: all phase

---

# Phase 1: 核心对话引擎 

/brainstorming 我想要手动实现一个类claude code 的cli agent，我取名为LICode。现需要你编写一个设计文档，主要内容如下：

- 基础对话能力：System Prompt工程、LLMAPI、流式响应、多轮对话、对话管理器                                           

- Agent 核心机制：Function Calling、Tools 工具系统、ReAct 范式、Agent Loop 主循环、事件流                 

- 能力扩展协议：MCP 协议、Skill 技能包、Slash Command 命令框架、Hook 生命周期钩子                     

- 工程化能力：权限防御、上下文压缩、Token 管理、上下文溢写、跨会话记忆、会话持久化、记忆提取                

- 多 Agent 协作：SubAgent 子任务分发、Git Worktree 并行隔离、Agent Teams 团队协作                     

- AI 编程实战：Vibe Coding 全流程，采用 Spec 开发模式（spec.md / tasks.md / checklist.md 三件套）+ CLAUDE.md项目指令。

你需要先设计出整体的一个目录，然后设计整个软件的框架（文件夹作用等）。其次为每一个功能的给出详细的设计方案，可能包括api接口说明，具体功能实现等。              

 **你打算用什么技术栈来实现 LICode？**

 A. **TypeScript/Node.js** — 与 Claude Code 本身一致，npm 生态成熟，CLI 开发自然

 B. **Python** — AI/LLM 生态最丰富，快速原型，但 CLI 体验不如 Node.js

 C. **Go** — 编译为单二进制分发方便，性能好，但 LLM 生态较新

 D. **Rust** — 极致性能，系统级控制，但开发周期长

❯ A — TypeScript/Node.js



接下来是关于 CLI 框架的选择。这是一个技术决策，用终端文字讨论就好。

 **你打算用什么 CLI 框架来构建 LICode 的终端交互界面？**

 A. **Ink (React for CLI)** — React 组件渲染到终端，声明式 UI，生态丰富（ink-text-input, ink-spinner 等）。Claude Code本身就用 Ink。适合构建丰富的交互体验

 B. **纯 Node.js readline/streams** —

 最轻量，无额外依赖，完全控制输入输出流。适合流式输出为主的场景，但复杂交互（选择器、面板、进度条）需要自己造轮子

 C. **Blessed / neo-blessed** — 成熟的终端 UI 库，基于 ncurses，支持多面板、鼠标事件。适合构建

 Dashboard、多窗口布局。但已较少维护

我的推荐是 **A（Ink）**：与 Claude Code 一致，React 声明式模型非常适合流式对话 + 工具调用 UI 的场景，社区生态成熟。

❯ A 吧，就用 Ink



**System Prompt 架构设计 —— 你希望 LICode 的 System Prompt 如何组织？**

 A. **单文件模板** — 所有系统指令集中在一个 prompt

 文件中，通过变量替换注入动态内容（环境信息、工具列表、日期等）。简单直接，但全部内容每次都发送，无法按需裁剪

 B. **分层组装（推荐）** — System Prompt 拆为基础层（角色定义、安全约束，永远发送）+ 能力层（工具描述、技能包，按需注入）+ 上下文层（项目文件、CLAUDE.md、记忆，动态拼接）。按 token 预算灵活裁切

 C. **对话内管理** — System Prompt 与普通消息一视同仁，统一存储在对话管理器的消息数组中，通过消息裁剪策略隐式控制 prompt长度。最灵活但缺少结构性保证

 我推荐 **B（分层组装）**：将 System Prompt 分为三个层次，让后续的 Token 管理和上下文压缩有清晰的干预点。 

❯ B



**对话管理器如何管理消息历史和会话状态？**

 A. **纯内存数组** — 消息以 Message[] 形式存在内存中，每次对话重新构造。简单但不持久化，适合无状态 CLI 场景

 B. **会话文件持久化（推荐）** — 每次对话自动保存到 session JSON

 文件（.licode/sessions/<id>.json），支持会话恢复、replay、中断续聊。消息数组 + 元数据（token 计数、时间戳、模型信息）

 C. **SQLite 持久化** — 使用 better-sqlite3 存储所有会话和消息，支持全文搜索历史、会话管理、多会话切换。功能最完整但也更重

 我推荐 **B（会话文件持久化）**：JSON 文件格式简单、可读、可手动编辑，自然支持 Git 管理（可分享/审查会话），且为 Phase 4的会话持久化做准备。不需要 SQLite 的查询能力因为会话恢复是按 ID 载入的。

❯ B



浏览器中展示了 3 种架构方案。我的推荐是 **A（事件管道）**：

 \- 中间件模式天然适配后续 Phase 的 Hook、MCP、Skill 扩展

 \- 事件作为通用语言，所有消费者（渲染器、日志、Hook）共享同一事件流

 \- Phase 2 的 Agent Loop 就是事件管道的循环

 你觉得哪个方案更合适？可以在浏览器中点击选择。

※ **recap:** *我们正在为 LICode（类 Claude Code 的 CLI Agent）做 Phase 1 核心对话引擎的设计。已收集了技术栈、LLM 策略、CLI* 

 *框架、System Prompt 架构等决策。当前等待你对 3 种架构方案的选择——推荐的是事件管道架构。你在浏览器中看到了吗？ (disable*

 *recaps in /config)*

❯ A 就 A 吧，继续下一步

# phase2



# phase3



# btw

agent它虽然文件目录跟events同级，但是它本质上跟events/middlewares当中的中间件都是一样的中间件吗？          

是的，你观察得很准确。agent/loop.ts 中的 createAgentLoopMiddleware 返回的就是一个标准的 Middleware 函数——和events/middleware/ 中的 loggingMiddleware、tokenCountingMiddleware 是同一类东西，满足同一个接口：



/btw 当前设计的event和middleware之间的区别是什么？agentLoop是指一个中间件还是一个事件？eventpipline编排的是事件还是中间件？在一次的会话里面是否会出现多次的agentLoop？多个agentLoop实例在什么时候被回收？                                                                       

    好问题，这四个概念很容易混淆。逐一厘清：
    
    ---
    Event 和 Middleware 的区别
    
    Event 是数据，Middleware 是函数。
    
    - Event = "刚才发生了什么"的结构化记录。它是一个值，被传递、被读取、被消费。类比：快递包裹。
    - Middleware = 接收 event 并决定要不要继续传递的函数。它是一个处理器，签名是 (event, next) => 
    Promise<void>。类比：快递站点的分拣员。
    
    Event 在管道中流动，Middleware 是管道的节点。
    
    ---
    agentLoop 是 middleware 还是 event？
    
    agentLoop 是 middleware，不是 event。 
    
    具体来说，createAgentLoopMiddleware() 返回一个 Middleware 函数。它注册为 EventPipeline 的一个中间件节点。
    
    但它内部会产生 events——agent-loop-step、tool-use-detected、agent-loop-complete 等，这些 events 通过 EventBus旁路发送给 UI，不经过主 EventPipeline。
    
    所以：agentLoop = 中间件（处理器），它在运行过程中发出心跳事件（数据）。
        
        ---
        EventPipeline 编排的是中间件还是事件？
        
        编排的是 中间件的执行顺序，事件是被处理的数据。
        
        pipeline
          .use(logging)      // ← 注册中间件，按顺序排列
          .use(agentLoop)    // ← 注册中间件
          .use(renderer)     // ← 注册中间件
          
        pipeline.run(events) // ← 传入事件流，事件按中间件链依次处理
          
        use() 决定"哪些中间件、什么顺序"，run() 把事件流送入这条链。类比：use() 是铺设水管，run() 是放水。
        
        ---
    ---
        一次会话中 agentLoop 会运行多次吗？
        
        会，而且是常态。 每次用户输入都会触发一次。
        
        用户输入 1 → agentLoop.run() → 3 轮 tool_use → 最终文本 → 循环退出
        用户输入 2 → agentLoop.run() → 无 tool_use → 直接返回 → 循环退出
        用户输入 3 → agentLoop.run() → 5 轮 tool_use → 达到步数上限 → 强制终止
        
        agentLoopMiddleware 内部是 while(true) 循环（一次 ReAct 会话），但作为中间件，它每次收到 user-message
        事件都会创建一个新的 AgentLoop 实例并调用 run()。所以：
        
        - 多个 user-message → 多次 agentLoop.run()
        - 每次 run() 内部可能多轮 LLM 调用（ReAct 循环）
        - 每次 run() 结束后，下一个 user-message 事件到来时再重新开始
    ---
    多个实例在事件流出之后，其引用会被删除，然后这些实例会在下一次javascript gc被回收
