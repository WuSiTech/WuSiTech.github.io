+++
title = "STM32 定时器：时基单元、PWM、输入捕获与编码器"
date = "2026-10-29T19:30:00+08:00"
lastmod = "2026-11-06T23:10:00+08:00"
draft = false
description = "以 STM32F103C8T6 与标准外设库为例，把 TIM 的时基单元、定时中断、输出比较与 PWM、输入捕获与 PWMI、编码器接口讲清楚，并给出可直接复用的 C 代码。"
categories = [ "STM32" ]
tags = [ "STM32", "TIM定时器", "PWM", "输入捕获", "编码器", "中断" ]
cover = "/images/pool/covers/covers-06.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 6 章（6-1 ~ 6-8）。

代码基于 **STM32F103C8T6 + 标准外设库 3.5.0**。按约定，这里不写新建工程、器件选型和接线步骤，只讲原理与代码；需要完整工程时对照视频即可。

| 小节 | 内容 | 对应视频 |
| ---- | ---- | -------- |
| 0x21 | 定时中断、内外时钟源 | 6-1、6-2 |
| 0x22 | 输出比较 | 6-3 |
| 0x23 | PWM、舵机、直流电机 | 6-3、6-4 |
| 0x24 | 输入捕获、测频、PWMI | 6-5、6-6 |
| 0x25 | 编码器接口、测速 | 6-7、6-8 |

## 0x00 什么是定时器(Timer,TIM)

定时器可以对输入的时钟进行计数，并在计数值达到设定值时触发中断或者事件。

定时器按复杂度和应用场景分为高级定时器、通用定时器和基本定时器，如图

![STM32 定时器分类：高级/通用/基本](static/images/obsidian/Pasted%20image%2020261105193123.webp)

注意：STM32F103C8T6 只有 **TIM1 ~ TIM4**（1 个高级 + 3 个通用），没有基本定时器 TIM6/TIM7。

除了“数时间”，定时器还能做这些事：

- **定时中断**：固定周期进中断，做软件定时、采样节拍；
- **输出比较 / PWM**：驱动 LED、舵机、直流电机、蜂鸣器；
- **输入捕获**：测频率、测周期、测占空比、测脉宽；
- **编码器接口**：直接读旋转编码器的正交信号，做位置/速度闭环；
- **主从触发**：定时器级联、硬件自动触发 ADC/DAC，不占 CPU。

## 0x10 定时器的组成

### 0x11 基本定时器

基本定时器是结构最简单的定时器，由**时基单元、时钟信号和触发控制器**构成。如图

![基本定时器框图](static/images/obsidian/Pasted%20image%2020261105194534.webp)

**时钟信号**是一种波，一般取其上升沿为触发。

**触发控制器**可以选择将时钟信号传入时基单元，或者送给 DAC（数模转换器）作为触发源——DAC 用定时器触发可以低资源占用地产生任意波形。

**时基单元**由以下三个寄存器构成：

- **预分频器(PSC)**：对时钟信号进行分频，让计数频率更灵活。实际分频系数 = 写入值 + 1（例如写 0 就是 1 分频，也就是不分频）。
- **计数器(CNT)**：执行计数定时的寄存器，对分频后的时钟信号计数，每来一个时钟上升沿加 1。
- **自动重装寄存器(ARR)**：储存计数的目标值，当计数器计到目标值时产生中断（更新中断）或者事件（更新事件），然后 CNT 回到 0 重新开始。

其中所有计数器都是 **16 位**的，最大值为 2^16 − 1 = 65535。PSC 和 ARR 也都有 16 位，所以单靠一个定时器，最大定时时间是有限的，超长定时要靠**级联**或者软件计数。

工作流程如下：

![基本定时器计数流程](static/images/obsidian/新建%20Bitmap%20image.webp)

> 补充一个容易忽略的点：PSC 和 ARR 都有**影子寄存器**。你写进去的值不会立刻生效，而是要等下一次更新事件（UEV）才被搬到工作寄存器。这样改参数时不会把当前正在计数的周期截断。HAL/标准库里的“预装载”开关控制的就是这个行为。

### 0x12 通用定时器

通用定时器由下图几部分组成，图中可分为三个部分：上（红）、左下（蓝）和右下（绿）。

![通用定时器框图](static/images/obsidian/新建%20Bitmap%20image%201.webp)

上部分（红）是基本定时器的“Plus 版”：时基单元的 CNT 可以选择向上计数（++）还是向下（--）计数（基本定时器只能 ++）；触发控制器可以选择时钟信号来源（TIMx_ETR 外部、ITRx 其他定时器、编码器等）；信号还可以送给 DAC 和 ADC。

左下（蓝）是**输入捕获电路**，拥有 4 个通道（CH1 ~ CH4），可以将捕获的信号送给“基本定时器 Plus”作为时钟来源，也可以把捕获到的 CNT 值存进黄色区域的 CCR。

右下（绿）是**输出比较电路**，可以把 CCR 的比较结果输出到引脚。

黄色区域是输入捕获电路和输出比较电路**共用**的部分：捕获/比较寄存器（CCR）。同一路 CCR 在同一时刻只能干一件事，所以输入捕获和输出比较不能同时占用同一个通道。

### 0x13 高级定时器

高级定时器 = 通用定时器 + 重复次数计数器 + 死区生成电路 DTG + 刹车输入 BKIN。

![高级定时器框图](static/images/obsidian/Pasted%20image%2020261105204030.webp)

- **重复计数器 RCR**：通用定时器是 CNT 每次溢出都产生更新事件；高级定时器可以设置“溢出 RCR+1 次才产生一次更新事件”，方便做整数倍分频。
- **死区生成电路**：互补输出（CH1/CH1N）在切换时插入一段死区，防止上下桥臂直通烧管，是电机驱动的刚需。
- **刹车输入 BKIN**：出现故障（过流、过压）时硬件立刻封住 PWM 输出，属于安全功能。

TIM1 和 TIM8 挂在 **APB2** 上，其余定时器挂在 APB1 上；另外 TIM1/TIM8 输出 PWM 前必须使能主输出（MOE），也就是调用 `TIM_CtrlPWMOutputs(TIM1, ENABLE)`，否则引脚上没有波形——这一点后面还会提。

## 0x20 定时器的功能

如 0x00 的图片所写，通用定时器有**定时中断、内外时钟源选择、输入捕获、输出比较、编码器接口、主从触发模式**等功能。其中常用的是通用定时器。

STM32 的定时器还支持**级联模式**，即可以“满 65536 进 1”：A 计数器计满 65536，通过 TRGO 触发 B 计数器 +1，同时 A 归 0 重新计数。

> 两个 16 位定时器级联，计数范围变成 2^32；按 72 MHz 计数，一次溢出约 59.65 秒。想再长只能继续级联，或者用软件再套一层计数。

接下来分别详细介绍各种功能。

### 0x21 定时中断和内外时钟源选择

定时中断的基本结构：时钟输入 → 时基单元 → 输出控制。

![定时中断基本结构](static/images/obsidian/Pasted%20image%2020261105204410.webp)

当 CNT 计到 ARR（向上计数）时，状态寄存器会先置一个**中断标志位**（UIF）。中断标志位通过**中断输出控制**（相当于一个开关）决定要不要向 NVIC 申请中断；即使不开中断，标志位本身也会置起来，所以可以用“查询标志位”的方式做轮询，也可以让这个事件去触发别的外设（ADC、DAC、其他定时器）。

几个关键公式：

```text
计数频率 fCNT = fCK_PSC / (PSC + 1)
定时频率 fOUT = fCK_PSC / ((PSC + 1) × (ARR + 1))
定时时间 t    = (PSC + 1) × (ARR + 1) / fCK_PSC
```

以 F103C8T6 为例，TIM2 挂在 APB1 上：APB1 分频系数不为 1 时，定时器时钟会自动 ×2，所以 `fCK_PSC = 72 MHz`。要 1 s 中断一次，可以取 `PSC = 7200 - 1`、`ARR = 10000 - 1`：72 MHz / 7200 / 10000 = 1 Hz。

**内外时钟源**：

| 时钟源 | 说明 |
| ------ | ---- |
| 内部时钟 CK_INT | 默认，来自 RCC 的 TIMxCLK（72 MHz） |
| 外部时钟模式 1 | 从 TI1/TI2 引脚输入，经过输入滤波和边沿检测后作为计数时钟 |
| 外部时钟模式 2 | 从 ETR 引脚输入，可配合预分频、极性、滤波 |
| 内部触发 ITR0 ~ ITR3 | 其他定时器的 TRGO，用于定时器级联 |
| 编码器接口 | TI1FP1/TI2FP2，正交解码 |

外部时钟模式 2 的典型写法（把 PA0 上的脉冲当成计数时钟）：

```c
TIM_ETRClockMode2Config(TIM2, TIM_ExtTRGPSC_OFF,
                        TIM_ExtTRGPolarity_NonInverted, 0x0F);
```

这样每来一个 ETR 上升沿，CNT 就 +1；配合 `TIM_GetCounter()` 就能做“红外对射计次”“按键计数”之类的事情，不需要进中断。

### 0x22 输出比较

输出比较（Output Compare，OC）做的事很朴素：**把 CNT 和 CCR 比大小**，根据比较结果控制输出引脚的电平。

![输出比较的 8 种模式](/images/posts/stm32-timer/oc-modes.webp)

8 种模式可以分成四组理解：

| 模式 | 行为 | 典型用途 |
| ---- | ---- | -------- |
| 冻结 | CNT == CCR 时 REF 保持原状态 | 暂停输出、保留电平 |
| 匹配时置有效电平 | 匹配瞬间 REF 变有效 | 单脉冲、延时翻转 |
| 匹配时置无效电平 | 匹配瞬间 REF 变无效 | 单脉冲、延时翻转 |
| 匹配时电平翻转 | 匹配瞬间 REF 翻转 | 输出方波（频率为更新频率的一半） |
| 强制为无效电平 | 与 CCR 无关，强制拉低 | 急停、关输出 |
| 强制为有效电平 | 与 CCR 无关，强制拉高 | 强制置位 |
| PWM 模式 1 | 向上计数：CNT < CCR 有效，CNT ≥ CCR 无效 | 最常用，正占空比 |
| PWM 模式 2 | 向上计数：CNT < CCR 无效，CNT ≥ CCR 有效 | 反占空比 |

这里的“有效/无效”是逻辑上的，真正到引脚还要经过**极性选择**（`TIM_OCPolarity_High/Low`）和**输出使能**（`TIM_OutputState_Enable`）。所以 **PWM 模式 1 + 高极性** 和 **PWM 模式 2 + 低极性** 在引脚上看到的是同一个波形，只是内部参考信号反了一次。

![输出比较通道的输出部分](/images/posts/stm32-timer/oc-channel.webp)

输出比较通道的内部链路大致是：CNT 与 CCR 比较 → 输出模式控制器 → OCxREF → 极性选择 → 输出使能 → 引脚。也就是说，CCR 只是“比较阈值”，最终波形由模式、极性、使能三者共同决定。

几个实践要点：

- CCR 是 16 位，写 `TIM_SetCompare1(TIM2, x)` 就是改阈值；
- 想让改 CCR 时不出现毛刺，可以打开 **OCx 预装载**（`TIM_OC1PreloadConfig(TIM2, TIM_OCPreload_Enable)`），让新值在更新事件时生效；
- 输出引脚必须配成**复用推挽**（`GPIO_Mode_AF_PP`），普通推挽是输出不了定时器波形的；
- 需要重映射时（例如 TIM3_CH1 从 PA6 换到 PB4），要先开 AFIO 时钟再 `GPIO_PinRemapConfig()`。

### 0x23 PWM

PWM（Pulse Width Modulation，脉冲宽度调制）就是在输出比较的基础上，让 CCR 固定、CNT 不断循环，于是一个周期内“高电平占多少”就由 CCR 决定。

![PWM 基本结构](/images/posts/stm32-timer/pwm-structure.webp)

PWM 的三个参数：

```text
频率     f = fCK_PSC / ((PSC + 1) × (ARR + 1))
占空比   Duty = CCR / (ARR + 1)
分辨率   Reso = 1 / (ARR + 1)
```

例如 72 MHz、PSC = 720−1、ARR = 100−1：频率 = 72 MHz / 720 / 100 = 1 kHz，CCR 从 0 写到 100 就对应 0% ~ 100% 占空比，分辨率 1%。

PWM 的意义在于：只要**负载有惯性**（LED 的余辉、电机的机械惯性、舵机的响应速度），用很快的通断去等效一个中间量，人眼/机械感受到的就是“模拟”的电压或力矩。频率太低会闪、会抖，频率太高开关损耗大，所以要按负载选频率。

#### 用 PWM 驱动 LED 呼吸灯

LED 接在 PA0（TIM2_CH1），1 kHz 足够，CCR 从 0 慢慢加到 100 再减回来，就是呼吸灯。代码见 0x32。

#### 用 PWM 驱动舵机

舵机是一种根据输入 PWM 信号占空比来控制输出角度的装置，信号要求：**周期 20 ms，高电平 0.5 ms ~ 2.5 ms**。

![舵机与 PWM 角度对应关系](/images/posts/stm32-timer/servo.webp)

- 0.5 ms → −90°
- 1.5 ms → 0°
- 2.5 ms → +90°

所以 ARR 要设成 20000−1，PSC 设成 72−1（72 MHz / 72 / 20000 = 50 Hz）。CCR 的范围就是 500 ~ 2500，和角度线性对应：

```c
// Angle: 0 ~ 180 度，对应 0.5 ms ~ 2.5 ms
PWM_SetCompare2(Angle / 180.0f * 2000 + 500);
```

舵机是位置伺服，给定占空比后它会自己转到对应角度，不需要额外的闭环；但要注意舵机的供电电流，直接拿单片机的 3.3 V 带不动，常见做法是外部 5 V 供电并共地。

#### 用 PWM 驱动直流电机

直流电机是一种将电能转换为机械能的装置，两个电极正接正转、反接反转。它属于**大功率器件**，GPIO 不能直接驱动，必须经过电机驱动电路。

![TB6612 与电机驱动电路](/images/posts/stm32-timer/motor-driver.webp)

课程用的是 **TB6612** 双路 H 桥驱动：

| 引脚 | 作用 |
| ---- | ---- |
| VM | 电机电源 4.5 ~ 10.5 V |
| VCC | 逻辑电源 2.7 ~ 5.5 V |
| GND | 电源地 |
| STBY | 待机控制，高电平正常工作 |
| PWMA / PWMB | A/B 两路 PWM 输入，调速 |
| AIN1 / AIN2 | A 路方向控制 |
| BIN1 / BIN2 | B 路方向控制 |
| AO1 / AO2 | A 路电机输出 |

控制逻辑：

- `AIN1 = 1, AIN2 = 0` → 正转；`AIN1 = 0, AIN2 = 1` → 反转；两个都为 0 → 停止（滑行）；
- `PWMA` 上给 PWM，占空比越大转速越高；
- `STBY` 拉低则整片待机，输出关闭。

所以电机代码 = 两路 GPIO 控方向 + 一路 PWM 控速度，参数为：PSC = 720−1、ARR = 100−1（1 kHz），CCR 取 0 ~ 100。若嫌 1 kHz 有啸叫，可以把频率提到 20 kHz（PSC = 72−1、ARR = 50−1）。

> 电机是感性负载，断电瞬间线圈会产生反向电动势，驱动板上一般自带续流二极管；自己搭 H 桥时一定要加，否则很容易炸管。另外电机电源和单片机电源要共地，但电机电流不要从单片机的 3.3 V 走。

### 0x24 输入捕获和主从触发模式

输入捕获（Input Capture，IC）：当通道引脚出现指定的电平跳变时，硬件立刻把当前 CNT 的值锁存进 CCR。于是“两次捕获之间 CNT 差了多少”就对应“两个边沿之间过了多长时间”。

![输入捕获通道（通道 1 输入部分）](/images/posts/stm32-timer/ic-channel.webp)

一个捕获通道包含：

- **输入滤波器**：按 `fDTS` 采样，连续 N 次相同才认，用来滤毛刺（`TIM_ICFilter`，0 ~ 15）；
- **边沿检测 & 极性选择**：上升沿、下降沿或双边沿；
- **输入分频器**：每 N 个事件才捕获一次（`TIM_ICPSC_DIV1/2/4/8`）；
- **捕获/比较寄存器 CCR**：捕获到的 CNT 值存在这里。

输入捕获最常用的两种测频思路：

![测频法与测周法、中界频率](/images/posts/stm32-timer/freq-measure.webp)

**测频法**：固定一个闸门时间 T（比如 1 s），数这段时间内有多少个上升沿 N，则 `fx = N / T`。

- 适合**高频**信号；T 越长越准，但响应越慢；
- 误差是 ±1 个计数，相对误差约 `1/N`。

**测周法**：用已知的标准频率 fc 去数“两个上升沿之间”有多少个计数 N，则周期 `Tx = N / fc`，频率 `fx = fc / N`。

- 适合**低频**信号；N 越大越准；
- 误差同样是 ±1 个计数，相对误差约 `1/N`。

两者的误差曲线在某个频率处相交，这个点叫**中界频率**：

```text
fm = sqrt(fc / T)
```

以 fc = 1 MHz、T = 1 s 为例，fm = 1 kHz。低于 1 kHz 用测周法更准，高于 1 kHz 用测频法更准。

#### 输入捕获基本结构

![输入捕获基本结构](/images/posts/stm32-timer/ic-structure.webp)

单通道测频的经典接法：

1. TIM3_CH1（PA6）配成输入捕获，上升沿捕获，直连 TI1；
2. 触发源选 `TI1FP1`，从模式选 `Reset`；
3. 每次捕获到上升沿，硬件自动把 CNT 清零，同时把“上一个周期的计数值”存进 CCR1。

这样 CCR1 里就是“一个完整周期的计数”，省掉了软件减法，也不会因为中断延迟产生误差。`PSC = 72−1` 时计数频率 1 MHz，一个计数 1 µs，于是：

```c
// fc = 1 MHz
uint32_t freq = 1000000 / (TIM_GetCapture1(TIM3) + 1);
```

`+1` 是因为捕获值 N 对应 N+1 个计数间隔（CNT 从 0 数到 N）。

注意量程：ARR = 65535，1 MHz 下最长只能测 65.535 ms 的周期，对应最低约 15.26 Hz。要测更低的频率，就把 PSC 调大（比如 10 kHz 计数，量程 6.55 s），代价是分辨率变粗。

#### PWMI 模式：同时测频率和占空比

PWMI（PWM Input）是输入捕获的一个组合用法：**一个通道测周期，另一个通道测高电平时间**。

![PWMI 基本结构](/images/posts/stm32-timer/pwmi-structure.webp)

- IC1 配成**上升沿、直连 TI1** → 捕获整个周期，存 CCR1；
- IC2 配成**下降沿、间接 TI2**（`TIM_ICSelection_IndirectTI`）→ 捕获高电平结束的时刻，存 CCR2；
- 触发源仍然用 TI1FP1，从模式 Reset，于是每个周期 CNT 都从 0 开始，CCR2 直接就是高电平的计数。

```c
频率   f   = fc / (CCR1 + 1)
占空比 Duty = (CCR2 + 1) / (CCR1 + 1) × 100%
```

标准库还提供了一个打包函数 `TIM_PWMIConfig()`，可以一次性把 IC1/IC2 配成 PWMI 模式；上面的写法是手动展开版，便于看清每一路在干什么。

### 0x25 编码器接口

编码器接口可以接收**增量式（正交）编码器**的信号：A、B 两相相差 90°，根据两相的相位关系和边沿顺序，硬件自动判断正转/反转，并让 CNT 自增或自减。

![正交编码器的正转与反转](/images/posts/stm32-timer/encoder-wave.webp)

- **正转**：A 相超前 B 相 90°；
- **反转**：B 相超前 A 相 90°。

判断方向只看“**当前边沿 + 另一相的电平**”：

| 边沿 | 另一相状态 | 计数方向 |
| ---- | ---------- | -------- |
| A 相 ↑ | B 低电平 | 向上 |
| A 相 ↑ | B 高电平 | 向下 |
| A 相 ↓ | B 高电平 | 向上 |
| A 相 ↓ | B 低电平 | 向下 |

![编码器模式下的计数器操作实例](/images/posts/stm32-timer/encoder-example.webp)

编码器接口只借用 CH1 和 CH2 两个通道，不占用输出比较。它支持三种计数模式：

- 只在 TI1 边沿计数（2 倍频）；
- 只在 TI2 边沿计数（2 倍频）；
- **TI1 和 TI2 都计数（4 倍频）**，最常用，分辨率最高。

所谓“4 倍频”，就是 A、B 各自的上升沿、下降沿都算一次，一个完整的正交周期能数到 4 个数。再配合编码器本身的线数和减速比，就能把“计数”换算成“圈数”：

```text
每输出轴转一圈的计数 = 编码器线数 × 减速比 × 倍频数
```

以常见的 11 线、30:1 减速电机、4 倍频为例：11 × 30 × 4 = 1320 个计数/圈。

测速时不需要每个边沿都进中断，只要**固定闸门时间读一次 CNT 再清零**：1 s 读一次，差值就是“每秒计数”，除以 1320 就是“圈/秒”，再乘 60 就是 RPM。闸门时间越长越平滑，但动态响应越慢。

## 0x30 代码实现

下面所有代码都基于标准外设库，只列核心文件；`Delay.h`、`OLED.h` 是课程配套的延时和 OLED 驱动，换成自己的实现即可。

### 0x31 定时中断（TIM2，1 s）

`Timer.c`：

```c
#include "stm32f10x.h"

void Timer_Init(void)
{
    /* 1. 开 TIM2 时钟（APB1） */
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM2, ENABLE);

    /* 2. 选内部时钟 CK_INT */
    TIM_InternalClockConfig(TIM2);

    /* 3. 时基单元：72MHz / 7200 / 10000 = 1Hz */
    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStructure;
    TIM_TimeBaseInitStructure.TIM_ClockDivision = TIM_CKD_DIV1;
    TIM_TimeBaseInitStructure.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStructure.TIM_Period = 10000 - 1;   /* ARR */
    TIM_TimeBaseInitStructure.TIM_Prescaler = 7200 - 1; /* PSC */
    TIM_TimeBaseInitStructure.TIM_RepetitionCounter = 0;
    TIM_TimeBaseInit(TIM2, &TIM_TimeBaseInitStructure);

    /* 4. 先清一次更新标志，避免刚使能中断就立刻进一次 */
    TIM_ClearFlag(TIM2, TIM_FLAG_Update);
    TIM_ITConfig(TIM2, TIM_IT_Update, ENABLE);

    /* 5. NVIC */
    NVIC_PriorityGroupConfig(NVIC_PriorityGroup_2);
    NVIC_InitTypeDef NVIC_InitStructure;
    NVIC_InitStructure.NVIC_IRQChannel = TIM2_IRQn;
    NVIC_InitStructure.NVIC_IRQChannelCmd = ENABLE;
    NVIC_InitStructure.NVIC_IRQChannelPreemptionPriority = 2;
    NVIC_InitStructure.NVIC_IRQChannelSubPriority = 1;
    NVIC_Init(&NVIC_InitStructure);

    /* 6. 启动 */
    TIM_Cmd(TIM2, ENABLE);
}
```

`main.c`：

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "OLED.h"

uint16_t Num;

int main(void)
{
    OLED_Init();
    Timer_Init();
    OLED_ShowString(1, 1, "Num:");

    while (1)
    {
        OLED_ShowNum(1, 5, Num, 5);              /* 中断里累加 */
        OLED_ShowNum(2, 1, TIM_GetCounter(TIM2), 5); /* 实时 CNT，能看到 0~9999 在跑 */
    }
}

void TIM2_IRQHandler(void)
{
    if (TIM_GetITStatus(TIM2, TIM_IT_Update) == SET)
    {
        Num++;
        TIM_ClearITPendingBit(TIM2, TIM_IT_Update);
    }
}
```

把 `TIM_InternalClockConfig(TIM2)` 换成 0x21 里的 `TIM_ETRClockMode2Config(...)`，再把 PA0 配成上拉输入，就是 6-2 的“外部时钟计数”：每来一个外部脉冲 CNT 加 1，`TIM_GetCounter()` 直接读计数值。

### 0x32 PWM（呼吸灯 / 舵机 / 直流电机）

`PWM.c`：把通道号做成参数，三个实验共用一套驱动（TIM2_CH1/CH2/CH3 → PA0/PA1/PA2）。

```c
#include "stm32f10x.h"

/* Channel: 1/2/3 → PA0/PA1/PA2（TIM2_CH1/CH2/CH3） */
void PWM_Init(uint8_t Channel, uint16_t Prescaler, uint16_t Period)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM2, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    if (Channel == 1)      GPIO_InitStructure.GPIO_Pin = GPIO_Pin_0;
    else if (Channel == 2) GPIO_InitStructure.GPIO_Pin = GPIO_Pin_1;
    else                   GPIO_InitStructure.GPIO_Pin = GPIO_Pin_2;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    TIM_InternalClockConfig(TIM2);

    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStructure;
    TIM_TimeBaseInitStructure.TIM_ClockDivision = TIM_CKD_DIV1;
    TIM_TimeBaseInitStructure.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStructure.TIM_Period = Period;
    TIM_TimeBaseInitStructure.TIM_Prescaler = Prescaler;
    TIM_TimeBaseInitStructure.TIM_RepetitionCounter = 0;
    TIM_TimeBaseInit(TIM2, &TIM_TimeBaseInitStructure);

    TIM_OCInitTypeDef TIM_OCInitStructure;
    TIM_OCStructInit(&TIM_OCInitStructure);   /* 先填默认值，避免未初始化字段乱跑 */
    TIM_OCInitStructure.TIM_OCMode = TIM_OCMode_PWM1;
    TIM_OCInitStructure.TIM_OCPolarity = TIM_OCPolarity_High;
    TIM_OCInitStructure.TIM_OutputState = TIM_OutputState_Enable;
    TIM_OCInitStructure.TIM_Pulse = 0;        /* CCR 初值 */
    if (Channel == 1)      TIM_OC1Init(TIM2, &TIM_OCInitStructure);
    else if (Channel == 2) TIM_OC2Init(TIM2, &TIM_OCInitStructure);
    else                   TIM_OC3Init(TIM2, &TIM_OCInitStructure);

    TIM_Cmd(TIM2, ENABLE);
}

void PWM_SetCompare(uint8_t Channel, uint16_t Compare)
{
    if (Channel == 1)      TIM_SetCompare1(TIM2, Compare);
    else if (Channel == 2) TIM_SetCompare2(TIM2, Compare);
    else                   TIM_SetCompare3(TIM2, Compare);
}
```

**呼吸灯**：`PWM_Init(1, 720 - 1, 100 - 1)`，CCR 在 0 ~ 100 之间来回。

```c
int main(void)
{
    OLED_Init();
    PWM_Init(1, 720 - 1, 100 - 1);   /* CH1 / PA0，1 kHz */

    while (1)
    {
        for (uint16_t i = 0; i <= 100; i++)
        {
            PWM_SetCompare(1, i);
            Delay_ms(20);
        }
        for (uint16_t i = 0; i <= 100; i++)
        {
            PWM_SetCompare(1, 100 - i);
            Delay_ms(20);
        }
    }
}
```

**舵机**：CH2 / PA1，50 Hz，CCR 500 ~ 2500。

```c
void Servo_Init(void)
{
    PWM_Init(2, 72 - 1, 20000 - 1);   /* CH2 / PA1，50 Hz */
}

void Servo_SetAngle(float Angle)      /* 0 ~ 180 度 */
{
    PWM_SetCompare(2, Angle / 180.0f * 2000 + 500);
}
```

**直流电机**：CH3 / PA2 出 PWM，PA4 / PA5 控方向，STBY 接 3.3 V。

```c
void Motor_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_4 | GPIO_Pin_5;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    PWM_Init(3, 720 - 1, 100 - 1);    /* CH3 / PA2，1 kHz */
    PWM_SetCompare(3, 0);
}

/* Speed: -100 ~ 100，正数正转，负数反转 */
void Motor_SetSpeed(int16_t Speed)
{
    if (Speed >= 0)
    {
        GPIO_SetBits(GPIOA, GPIO_Pin_4);
        GPIO_ResetBits(GPIOA, GPIO_Pin_5);
        PWM_SetCompare(3, Speed);
    }
    else
    {
        GPIO_ResetBits(GPIOA, GPIO_Pin_4);
        GPIO_SetBits(GPIOA, GPIO_Pin_5);
        PWM_SetCompare(3, -Speed);
    }
}
```

> 想让改 CCR 时波形不出毛刺，可以对对应通道再调一次 `TIM_OCxPreloadConfig(TIMx, TIM_OCPreload_Enable)`，并打开 `TIM_ARRPreloadConfig(TIMx, ENABLE)`，让新值等更新事件再生效。

### 0x33 输入捕获（测频率 + PWMI 测占空比）

`IC.c`（TIM3_CH1 / PA6，1 MHz 计数）：

```c
#include "stm32f10x.h"

void IC_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM3, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_6;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    TIM_InternalClockConfig(TIM3);

    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStructure;
    TIM_TimeBaseInitStructure.TIM_ClockDivision = TIM_CKD_DIV1;
    TIM_TimeBaseInitStructure.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStructure.TIM_Period = 65536 - 1;
    TIM_TimeBaseInitStructure.TIM_Prescaler = 72 - 1;   /* 1 MHz */
    TIM_TimeBaseInitStructure.TIM_RepetitionCounter = 0;
    TIM_TimeBaseInit(TIM3, &TIM_TimeBaseInitStructure);

    /* CH1：上升沿、直连 TI1 */
    TIM_ICInitTypeDef TIM_ICInitStructure;
    TIM_ICInitStructure.TIM_Channel = TIM_Channel_1;
    TIM_ICInitStructure.TIM_ICFilter = 0xF;
    TIM_ICInitStructure.TIM_ICPolarity = TIM_ICPolarity_Rising;
    TIM_ICInitStructure.TIM_ICPrescaler = TIM_ICPSC_DIV1;
    TIM_ICInitStructure.TIM_ICSelection = TIM_ICSelection_DirectTI;
    TIM_ICInit(TIM3, &TIM_ICInitStructure);

    /* 主从触发：TI1FP1 触发，从模式 Reset，捕获后自动清 CNT */
    TIM_SelectInputTrigger(TIM3, TIM_TS_TI1FP1);
    TIM_SelectSlaveMode(TIM3, TIM_SlaveMode_Reset);

    TIM_Cmd(TIM3, ENABLE);
}

uint32_t IC_GetFreq(void)
{
    return 1000000 / (TIM_GetCapture1(TIM3) + 1);
}
```

`main.c`：把 PA6 接到待测信号上，OLED 显示频率。

```c
int main(void)
{
    OLED_Init();
    IC_Init();
    OLED_ShowString(1, 1, "Freq:000000Hz");

    while (1)
    {
        OLED_ShowNum(1, 6, IC_GetFreq(), 6);
    }
}
```

**PWMI**：在 `IC_Init` 里再加一路 IC2，下降沿、间接 TI2。

```c
    TIM_ICInitStructure.TIM_Channel = TIM_Channel_2;
    TIM_ICInitStructure.TIM_ICFilter = 0xF;
    TIM_ICInitStructure.TIM_ICPolarity = TIM_ICPolarity_Falling;
    TIM_ICInitStructure.TIM_ICPrescaler = TIM_ICPSC_DIV1;
    TIM_ICInitStructure.TIM_ICSelection = TIM_ICSelection_IndirectTI;
    TIM_ICInit(TIM3, &TIM_ICInitStructure);
```

```c
uint32_t IC_GetDuty(void)
{
    /* CCR2 = 高电平计数，CCR1 = 整周期计数 */
    return (uint32_t)(TIM_GetCapture2(TIM3) + 1) * 100 /
           (TIM_GetCapture1(TIM3) + 1);
}
```

自测时可以用另一路 PWM 当信号源：`PWM_Init(720 - 1, 100 - 1)` 输出 1 kHz，`PWM_SetCompare1(50)` 就是 50% 占空比；把 PA0 和 PA6 用杜邦线连起来，屏幕上应显示约 1000 Hz、50%。

### 0x34 编码器接口与测速

`Encoder.c`（TIM3_CH1/CH2 = PA6/PA7）：

```c
#include "stm32f10x.h"

void Encoder_Init(void)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM3, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_6 | GPIO_Pin_7;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStructure;
    TIM_TimeBaseInitStructure.TIM_ClockDivision = TIM_CKD_DIV1;
    TIM_TimeBaseInitStructure.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStructure.TIM_Period = 65536 - 1;
    TIM_TimeBaseInitStructure.TIM_Prescaler = 1 - 1;   /* 编码器模式里 PSC 一般不分频 */
    TIM_TimeBaseInitStructure.TIM_RepetitionCounter = 0;
    TIM_TimeBaseInit(TIM3, &TIM_TimeBaseInitStructure);

    TIM_ICInitTypeDef TIM_ICInitStructure;
    TIM_ICStructInit(&TIM_ICInitStructure);
    TIM_ICInitStructure.TIM_Channel = TIM_Channel_1;
    TIM_ICInitStructure.TIM_ICFilter = 0xF;
    TIM_ICInit(TIM3, &TIM_ICInitStructure);
    TIM_ICInitStructure.TIM_Channel = TIM_Channel_2;
    TIM_ICInitStructure.TIM_ICFilter = 0xF;
    TIM_ICInit(TIM3, &TIM_ICInitStructure);

    /* TI1 和 TI2 都计数 = 4 倍频 */
    TIM_EncoderInterfaceConfig(TIM3, TIM_EncoderMode_TI12,
                               TIM_ICPolarity_Rising, TIM_ICPolarity_Rising);

    TIM_Cmd(TIM3, ENABLE);
}

/* 读一次并清零：返回这段时间内的计数差（带符号） */
int16_t Encoder_Get(void)
{
    int16_t Temp = TIM_GetCounter(TIM3);
    TIM_SetCounter(TIM3, 0);
    return Temp;
}
```

测速：用 TIM2 的 1 s 中断做闸门，每次中断读一次编码器差值。

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "OLED.h"
#include "Timer.h"
#include "Encoder.h"

int16_t Speed;          /* 每秒计数 */
float RPS;              /* 圈/秒 */

int main(void)
{
    OLED_Init();
    Encoder_Init();
    Timer_Init();       /* 复用 0x31 的 1 s 定时中断 */
    OLED_ShowString(1, 1, "Speed:000.00r/s");

    while (1)
    {
        RPS = Speed / 1320.0f;     /* 11 线 × 30 减速比 × 4 倍频 */
        OLED_ShowNum(2, 1, (uint16_t)RPS, 3);
        OLED_ShowNum(2, 5, (uint16_t)(RPS * 100) % 100, 2);
    }
}

void TIM2_IRQHandler(void)
{
    if (TIM_GetITStatus(TIM2, TIM_IT_Update) == SET)
    {
        Speed = Encoder_Get();
        TIM_ClearITPendingBit(TIM2, TIM_IT_Update);
    }
}
```

如果想显示 RPM，把 `RPS * 60` 即可；想滤波，可以对连续几次的 `Speed` 做滑动平均。

## 0x40 常见问题

1. **不开时钟**：TIM2 ~ TIM7 在 APB1（`RCC_APB1PeriphClockCmd`），TIM1/TIM8 在 APB2；GPIO 在 APB2。少开一个就完全没反应。
2. **PSC/ARR 忘了减 1**：库函数写的是“分频系数 − 1”“周期 − 1”，写 7200 实际是 7201 分频。
3. **PWM 引脚配成普通推挽**：必须是 `GPIO_Mode_AF_PP`，否则引脚不受定时器控制。
4. **TIM1/TIM8 没有主输出**：高级定时器要 `TIM_CtrlPWMOutputs(TIM1, ENABLE)` 打开 MOE，否则 CCR 配得再对也没波形。
5. **一开中断就进一次**：使能中断前先 `TIM_ClearFlag(TIMx, TIM_FLAG_Update)`，把上电时留下的更新标志清掉。
6. **输入捕获读到的是累计值**：没有配从模式 Reset 时，CNT 不会在捕获后清零，`CCR` 里是绝对时刻。测周期要么做减法，要么用 `TIM_SlaveMode_Reset`。
7. **输入捕获量程不够**：1 MHz 计数、16 位 CNT 最多 65.5 ms；测低频要把 PSC 调大，或者用“溢出中断 + 软件扩展位数”。
8. **编码器计数方向反了**：把 A/B 任一相换一下，或者改 `TIM_EncoderInterfaceConfig` 里两个极性参数即可；不要靠软件取反硬补。
9. **CCR 大于 ARR**：PWM 会一直保持有效电平（100%），调参时先限幅。
10. **电机/舵机供电**：舵机、电机不要从单片机 3.3 V 取电；电机电源与逻辑电源共地，但大电流走独立回路。

## 0x50 小结

| 功能 | 关键配置 | 典型用途 |
| ---- | -------- | -------- |
| 定时中断 | PSC/ARR + 更新中断 + NVIC | 软件定时、采样节拍 |
| 外部时钟 | `TIM_ETRClockMode2Config` | 脉冲计数、按键/传感器计次 |
| 输出比较 | CCR + OC 模式 | 方波、单脉冲、延时翻转 |
| PWM | PWM 模式 + CCR + AF 引脚 | LED、舵机、电机、蜂鸣器 |
| 输入捕获 | IC + 从模式 Reset | 测频率、周期、脉宽 |
| PWMI | IC1 直连 + IC2 间接 | 同时测频率与占空比 |
| 编码器接口 | `TIM_EncoderInterfaceConfig` | 位置、速度、方向 |

TIM 的内容看着多，其实核心就一句话：**时基单元负责“数时间”，CCR 负责“比较”，输入捕获负责“记录时刻”，编码器接口负责“看相位”**。把这四件事拆开，再回头看框图，就不会觉得那张图密密麻麻了。
