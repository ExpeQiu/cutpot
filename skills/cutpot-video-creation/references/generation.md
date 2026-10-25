# 服务执行与故障处理

## 调用前

加载对应服务 Skill，查看当前 CLI 帮助。检查接受版输入、上传范围、输出目录、已有任务及预算/次数。参数用 subprocess 数组传递；记录 argv、输入 SHA256、attempt、run-id、任务 ID、解析后工作流、provider、状态及下载路径，不复制凭据。

重做单开 `Sxx/attemptNN/`，保存 request、submission、result、download 和原片，记录接受/拒绝理由。提交超时先查询已有任务，不直接重提。失败先诊断，修订次数以当前授权为准，不沿用本项目历史“6次Pro”等上限。

## 即梦图片

常用 `dreamina image2image` 提交，凭 `submit_id` 以 `query_result` 查询并下载。参数组合从 `dreamina -h` 及子命令帮助确认。历史采用16:9、2K、每次一张、`--poll 0`，这是案例参数。

先定锚点，再让依赖镜头引用接受版。中文/空格文件名如遇上传兼容问题，在独立上传目录生成简短唯一名称的副本，保留原图及转换、哈希记录。不因下载成功就自动发布为接受版。

querying 只是受理，success 是任务成功，fail 需读具体原因。未指定模型时沿用当前默认，指定 Pro 等版本先核对支持。不擅改登录态；首次模型确认类错误按服务提示处理，不盲目重试。

## AutoDL 视频

读取远端实际能力：

```sh
autodl-cli config check --format json
autodl-cli service list --exposed --format json
autodl-cli compute health --format json
```

本机18090经 SSH 指向算力机8090；8188/8088状态不能证明编排18090可用。服务失败按 autodl-cli Skill 排查，不改回 Mac 编排、不自动切服务或开 GPU。外层 ok=true、data_source=live 仍需核对 provider 和工作流。

以下仅为历史成功参数形状，执行前核对当前目录及帮助。FIRST、LAST、PROMPT、RUN_ID 是待替换值：

```sh
autodl-cli job submit --modality video \
  --play first_last_frame --image FIRST --end-image LAST \
  --prompt PROMPT --width 1280 --height 768 --duration 5 \
  --fps 24 --steps 4 --seed 519021 --run-id RUN_ID --format json
autodl-cli job get JOB_ID --format json
autodl-cli job file JOB_ID -o /absolute/attemptNN/raw.mp4 --format json
```

当前省略 `--workflow`，由 `--play first_last_frame` 选择工作流；核对返回的实际workflow与provider。历史曾以 `t2v.u03 + first_last_frame` 解析为 `t2v.flf2v`，不把旧别名作为新命令模板。用户要求首尾帧时，单首帧结果只能作候选。

**该部署必须串行**：服务端历史使用固定 first.png/last.png 覆盖上传，曾导致 S21 输出 S29。上一任务到终态、下载、确认实际首帧与请求相符后，才上传下一镜。仅等终态不够，自动生成检查拼图不等于已目视验收；不同时运行多个上传批次。只有证实服务端已采用任务隔离路径并验证后，才考虑放宽。

有界查询，超时保存 ID 和状态，后续继续查同一任务。下载后 probe 并完整播放，重点比对首帧、关键动作、中段和尾帧；串图即作废。

## 穿帮或漂移后的即梦修订

按当前持续授权，问题镜头可使用即梦Seedance 2.0二次创作。先读dreamina-cli技能及相关子命令帮助，核实指定模型是否支持首尾帧和目标规格；支持时显式选择并记录实际模型，不能把默认模型当作Seedance 2.0。不可用时说明原因，不自动切换版本。

以接受的首尾帧和问题记录重写动作描述，逐字旁白留给后期；优先缩小动作、减少跨机位连续运动。先做代表段，检查完整片段及衔接后再替换；保留原片、请求、任务ID、模型、费用和接受/拒绝理由，不无限重试。曹冲历史修订并未显式传模型版本，其效果不构成指定模型的验证证据。

## 历史尺寸与时长限制

MiniMax H3 曾直接1280×720发生 latent 形状不匹配；当时验证路径为1280×768生成，上下各裁24px至1280×720，不放大。构图预留头脚空间，裁后复核。这是特定部署故障规避，不是通用模型规则；升级后可重新验证。

H3 帧数曾向上对齐17k+5，请求秒数不等于实际长度，以 probe 为准。曾24fps生成、25fps交付，应转换帧率而非改播放速度。不要默认补重复帧、慢放或加速；如定格尾帧延长，明确标记并验收动作已完整。

背景新增周年牌等时，先缩小动作或按范围重做；背景静止且无人物遮挡时可用接受首帧对应区域合成修复。记录区域、遮挡限制，检查整个片段，不称原片完全通过。
