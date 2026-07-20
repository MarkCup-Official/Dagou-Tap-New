# 开发与音高验证工具

此目录不参与网页运行，发布或打包时可以整体排除。

`analyze_pitch.py` 会：

1. 使用逐帧 YIN 检测 `audio/da.wav`、`gou.wav`、`jiao.wav`；
2. 从高能量、高置信度有声帧计算参考基频；
3. 按 C–G–Am–F 当前和弦生成四档映射；
4. 保持第三档 `playbackRate = 1`；
5. 对其余档位实际重采样后重新检测音高；
6. 将报告和可选试听 WAV 写入 `tools/tmp/`。

运行：

```powershell
python tools/analyze_pitch.py --write-wavs
node tools/verify_runtime_mapping.mjs
```

第二条命令会直接提取并执行 `main.js` 中的实际映射函数，对照分析报告检查
全部音节、和弦与音高档位。

依赖 Python 3 与 NumPy。所有报告、调试数据和临时音频必须放在
`tools/tmp/`，不要让生产页面依赖这里的任何文件。
