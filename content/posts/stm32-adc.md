+++
title = "STM32 ADC：从逐次逼近到单通道、多通道与 DMA 采集"
date = "2026-10-30T19:30:00+08:00"
lastmod = "2026-11-06T23:40:00+08:00"
draft = false
description = "以 STM32F103C8T6 与标准外设库为例，从采样定理、源阻抗与转换时间讲起，吃透规则组/注入组、校准、内部温度与 Vrefint，再给出单通道轮询、多通道扫描+DMA、注入组、数字滤波的完整 .h/.c/main.c 代码与调试方法。"
categories = [ "STM32" ]
tags = [ "STM32", "ADC", "DMA", "采样" ]
cover = "/images/pool/covers/covers-07.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 7 章（7-1、7-2）。

代码基于 **STM32F103C8T6 + STM32F10x 标准外设库 3.5.0**（API 已按 STM32F10x StdPeriph 3.5 头文件核对；Delay/OLED/Key 为课程配套驱动），不包含新建工程和接线步骤；文中所有 `.c/.h` 都可以直接拖进工程编译。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 7-1 | ADC 简介、逐次逼近、STM32 ADC 框图、输入通道、转换模式、转换时间、硬件电路、状态寄存器 | 0x00、0x10、0x20、0x30 |
| 7-2 | AD 单通道、AD 多通道、代码 | 0x40 ~ 0x55 |

视频之外还补了：采样定理与源阻抗计算、定时器触发 + DMA、注入组、Vrefint 反推 VDDA、数字滤波、输入保护、12 条故障排查。

## 0x00 从物理量到数字量

单片机只认识 0 和 1，但真实世界是连续的：电池电压从 12.6 V 慢慢掉到 10.8 V，电位器被拧到某个角度，光敏电阻的阻值随光照变化，电机电流在几安培里抖动。要让程序“看见”这些量，必须先把它们变成电压，再变成数字。

一条完整的采集链是这样的：

```text
物理量 → 传感器（电阻/电压/电流） → 调理电路（分压/放大/滤波）
       → ADC（采样、量化、编码） → 数字滤波 → 标定 → 使用
```

ADC（Analog-Digital Converter）就是中间那一环。它把引脚上的电压和参考电压比较，输出一个比例数字：

```text
CODE = VIN / VREF × 2^N
VIN  = CODE / 2^N × VREF
```

F103 的 ADC 是 **12 位逐次逼近型**，VREF 通常就是 VDDA = 3.3 V，所以：

```text
CODE 范围：0 ~ 4095
分辨率  ：3.3 V / 4096 ≈ 0.806 mV
```

注意“分辨率”和“精度”不是一回事：分辨率是“最小能分辨 0.806 mV”，精度是“读数和真实值差多少”。一块 12 位 ADC 的实际精度可能只有 10 位，误差来自参考电压、噪声、源阻抗、温漂和校准。

### 0x01 什么时候需要 ADC

| 场景 | 被测量 | 典型电路 |
| ---- | ------ | -------- |
| 电池电量 | 电池电压 | 电阻分压 |
| 旋钮/摇杆 | 电位器分压 | 电位器接 VREF-GND |
| 光照 | 光敏电阻阻值 | 与固定电阻分压 |
| 温度 | 热敏电阻/NTC | 分压或电桥 |
| 电流 | 采样电阻压降 | 差分放大 + 采样电阻 |
| 音频/波形 | 交流电压 | 偏置 + 抗混叠滤波 |

对应的软件需求也不同：电池电压几秒采一次就够；音频要几十 kHz 连续采样；电流保护要在 µs 级响应。这也决定了后面选“单次轮询”“连续+DMA”还是“注入组”。

## 0x10 逐次逼近型 ADC 的原理

![逐次逼近型 ADC（以 ADC0809 为例）](/images/posts/stm32-adc/adc-sar.webp)

逐次逼近（Successive Approximation Register，SAR）的核心是**二分搜索**：

1. 采样保持电路把输入电压“冻”在电容上；
2. SAR 从最高位（MSB）开始，先假设这一位是 1，经内部 DAC 变回模拟电压；
3. 用比较器比较“DAC 输出”和“输入电压”：
   - DAC 输出大 → 这一位改回 0；
   - DAC 输出小 → 保留 1；
4. 继续下一位，重复 N 次，最后 SAR 里的值就是转换结果。

以 3.3 V 参考、输入 2.000 V 为例（12 位，1 LSB = 0.806 mV）：

| 步骤 | 试填位 | DAC 输出 | 比较 | 结果 |
| ---- | ------ | -------- | ---- | ---- |
| 1 | bit11 = 1 | 1.650 V | 小于 2.000 | 保留 1 |
| 2 | bit10 = 1 | 2.475 V | 大于 2.000 | 改回 0 |
| 3 | bit9 = 1 | 2.062 V | 大于 2.000 | 改回 0 |
| 4 | bit8 = 1 | 1.856 V | 小于 2.000 | 保留 1 |
| … | … | … | … | … |
| 12 | bit0 = 1 | 2.000 V | 基本相等 | 完成 |

最终得到 `2.000 / 3.3 × 4096 ≈ 2482`，即 `0x9B2`。12 位就要比较 12 次，所以 SAR ADC 的速度由“比较器速度 + 位数”决定；F103 在 14 MHz ADC 时钟下最快约 1 µs 完成一次。

### 0x11 采样、量化、编码

- **采样**：在某一瞬间把电压存到采样电容上。采样开关闭合期间，外部信号通过源阻抗给电容充电；充电不充分，采样值就偏小。
- **量化**：把连续电压映射到 4096 个离散台阶。落在两个台阶之间的值只能“就近取整”，最大误差 ±1/2 LSB ≈ ±0.4 mV。
- **编码**：把台阶号写成 12 位二进制，存进数据寄存器。

量化误差是原理性的，无法消除；能优化的是参考电压稳定性、源阻抗、采样时间和 PCB 噪声。

### 0x12 采样定理与抗混叠

要对最高频率为 `fmax` 的信号不丢信息，采样率必须满足：

```text
fs ≥ 2 × fmax
```

如果 `fs < 2fmax`，高频成分会“混叠”成低频。例如用 1 kHz 采样一个 1.6 kHz 的正弦波，频谱上会出现 400 Hz 的假信号——示波器上看到的是完全不存在的波形。

工程上一般取 **5 ~ 10 倍**，并在 ADC 前加**抗混叠低通滤波**。一阶 RC 的截止频率：

```text
fc = 1 / (2πRC)
```

例如 R = 1 kΩ、C = 100 nF：

```text
fc = 1 / (2π × 1000 × 100e-9) ≈ 1.59 kHz
```

对 1 kHz 以下的信号，这个滤波器能把 10 kHz 以上的干扰衰减 20 dB 左右；要更陡就上二阶/有源滤波。

### 0x13 源阻抗与采样时间

ADC 的采样保持电容 `C_ADC`（F103 约 8 pF）要在采样窗口内充到足够精度。充电是 RC 过程，所需时间近似：

```text
t_s ≥ (R_source + R_ADC) × C_ADC × ln(2^(N+1))
```

12 位时 `ln(2^13) ≈ 9.01`，`R_ADC ≈ 1 kΩ`。若信号源内阻 10 kΩ：

```text
t_s ≥ (10k + 1k) × 8p × 9.01 ≈ 792 ns
```

ADC 时钟 12 MHz 时一个周期 83 ns，至少需要 10 个采样周期。这就是为什么“高阻抗信号要加长采样时间”，也是 STM32 提供 1.5 ~ 239.5 周期多档采样时间的原因。

F103 的采样时间档位（`ADC_SampleTime_xCycles5`）：

| 档位 | 周期数 | 12 MHz 下时间 |
| ---- | ------ | ------------- |
| 1.5 | 1.5 | 0.125 µs |
| 7.5 | 7.5 | 0.625 µs |
| 13.5 | 13.5 | 1.125 µs |
| 28.5 | 28.5 | 2.375 µs |
| 41.5 | 41.5 | 3.458 µs |
| 55.5 | 55.5 | 4.625 µs |
| 71.5 | 71.5 | 5.958 µs |
| 239.5 | 239.5 | 19.958 µs |

课程里默认用 55.5 周期，兼顾速度和一般源阻抗；测内部温度、Vrefint 时要求 239.5 周期。

## 0x20 STM32 的 ADC 结构

![STM32 ADC 框图](/images/posts/stm32-adc/adc-block.webp)

F103 的 ADC 主要特性：

| 项目 | 参数 |
| ---- | ---- |
| 分辨率 | 12 位 |
| 输入范围 | VSSA ≤ VIN ≤ VDDA（0 ~ 3.3 V） |
| 通道数 | 18 个：16 外部 + 温度 + VREFINT |
| 转换单元 | 规则组 16 序列、注入组 4 序列 |
| 结果寄存器 | 规则组共用 DR；注入组 4 个 JDRx |
| 触发源 | 软件、定时器 TRGO、EXTI 等 |
| 时钟 | ADCCLK ≤ 14 MHz，PCLK2 分频 |
| 特殊功能 | 扫描、连续、间断、模拟看门狗、DMA |

STM32F103C8T6 只有 **ADC1 和 ADC2**（没有 ADC3），外部通道 10 个（PA0 ~ PA7、PB0、PB1）。

### 0x21 通道与引脚

| 通道 | ADC1 | ADC2 | 备注 |
| ---- | ---- | ---- | ---- |
| IN0 | PA0 | PA0 | |
| IN1 | PA1 | PA1 | |
| IN2 | PA2 | PA2 | |
| IN3 | PA3 | PA3 | |
| IN4 | PA4 | PA4 | |
| IN5 | PA5 | PA5 | |
| IN6 | PA6 | PA6 | |
| IN7 | PA7 | PA7 | |
| IN8 | PB0 | PB0 | |
| IN9 | PB1 | PB1 | |
| IN16 | 温度传感器 | — | 内部 |
| IN17 | VREFINT | — | 内部 1.20 V |

选通道就是选引脚，ADC1_IN0 固定是 PA0，不能随便映射。

### 0x22 规则组与注入组

![ADC 基本结构](/images/posts/stm32-adc/adc-basic.webp)

- **规则组（Regular）**：日常采集用，最多 16 个通道排成序列，按顺序转换。所有通道**共用一个 DR**，所以多通道时必须靠 DMA 或“每次转换完立刻读”搬数据，否则会被下一个通道覆盖。
- **注入组（Injected）**：可以打断规则组，最多 4 个通道，每个通道有独立的 `JDR1 ~ JDR4`。适合“紧急采样”，例如电机过流保护、电源掉电检测。

注入组的“打断”是硬件级的：规则组正在转换时，注入触发到来，ADC 会先完成当前规则转换，再转注入序列，转完回到规则序列继续。

### 0x23 转换模式

| 模式 | 含义 | 适合 |
| ---- | ---- | ---- |
| 单次（Single） | 触发一次，转换一个序列 | 按键、低功耗采样 |
| 连续（Continuous） | 一次触发后不停转换 | 实时监测、DMA |
| 扫描（Scan） | 序列里多个通道依次转 | 多通道采集 |
| 间断（Discontinuous） | 每次触发只转 N 个 | 分组采样 |

单通道一般“单次 + 软件触发”；多通道一般“扫描 + 连续 + DMA”。

### 0x24 触发源

| 触发源 | 说明 |
| ------ | ---- |
| 软件（SWSTART） | 写 CR2 的 SWSTART |
| TIM1/2/3/4 的 TRGO | 定时器按固定频率触发，最常用 |
| TIM1/2/3/4 的 CCx | 比较事件触发 |
| EXTI 线 11 | 外部中断触发 |
| 注入组专用触发 | TIM1_TRGO、TIM1_CC4、EXTI15 等 |

用定时器触发可以实现“严格等间隔采样”，比软件循环 `Delay` 准确得多，配合 DMA 就是一台简易数据采集器。

### 0x25 时钟与转换时间

ADC 时钟来自 PCLK2 分频：

```c
RCC_ADCCLKConfig(RCC_PCLK2_Div6);   // 72 / 6 = 12 MHz
```

ADCCLK 最大 14 MHz。总转换时间：

```text
TCONV = 采样时间 + 12.5 个 ADC 周期
```

12 MHz 下：

| 采样周期 | 总周期 | 转换时间 |
| -------- | ------ | -------- |
| 1.5 | 14 | 1.17 µs |
| 55.5 | 68 | 5.67 µs |
| 239.5 | 252 | 21.0 µs |

所以 12 MHz、55.5 周期时，单通道最高采样率约 176 kHz；实际还要减去软件开销。

### 0x26 数据对齐、校准与看门狗

- **数据对齐**：12 位结果可右对齐（0 ~ 4095）或左对齐（高 12 位有效）。一般用右对齐，读出来直接是数值。
- **校准**：上电必须做一次，先 `ADC_ResetCalibration` 再 `ADC_StartCalibration`，各自等标志结束。不校准，零点误差可能几十个 LSB。
- **模拟看门狗**：设定上下阈值，转换结果越界就置 `AWD` 标志/进中断，适合电压监控，CPU 不用一直查。
- **内部通道**：
  - 温度：`ADC_Channel_16`，`T = (V25 - VSENSE) / Avg_Slope + 25`，V25 ≈ 1.43 V，Avg_Slope ≈ 4.3 mV/°C；
  - VREFINT：`ADC_Channel_17`，典型 1.20 V，可反推 VDDA：`VDDA = 1.20 × 4095 / CODE`。

### 0x27 关键寄存器

| 寄存器 | 作用 | 常用位 |
| ------ | ---- | ------ |
| `ADC_SR` | 状态 | EOC、JEOC、STRT、JSTRT、AWD、OVR |
| `ADC_CR1` | 控制 1 | SCAN、JOCCOS、AWDEN、JAWDEN |
| `ADC_CR2` | 控制 2 | ADON、CONT、CAL、RSTCAL、SWSTART、JSWSTART、EXTTRIG |
| `ADC_SMPR1/2` | 采样时间 | SMPx[2:0] |
| `ADC_SQR1~3` | 规则序列 | L[3:0]、SQx[4:0] |
| `ADC_JSQR` | 注入序列 | JL[1:0]、JSQx[4:0] |
| `ADC_DR` | 规则数据 | DATA[15:0] |
| `ADC_JDR1~4` | 注入数据 | JDATA[15:0] |

标准库的 `ADC_Init` / `ADC_RegularChannelConfig` 就是在填这些寄存器；理解它们，出问题时才能直接看寄存器定位。

## 0x30 硬件设计

### 0x31 电位器分压

最常见的实验：10 kΩ 电位器两端接 3.3 V 和 GND，中间抽头接 PA0。

```text
VIN = 3.3 × (R下 / 10k)
```

抽头从最下到最上，VIN 从 0 V 到 3.3 V，CODE 从 0 到 4095。电位器的最大源阻抗是 2.5 kΩ（中间位置），55.5 周期足够。

### 0x32 电池电压分压

电池电压可能高于 3.3 V，必须分压：

```text
VIN = VBAT × R2 / (R1 + R2)
```

12 V 电池、R1 = 100 kΩ、R2 = 33 kΩ：

```text
VIN = 12 × 33 / 133 ≈ 2.98 V   （安全）
VBAT = CODE / 4095 × 3.3 × (R1 + R2) / R2
```

分压电阻越大越省电，但源阻抗也越大，要相应加长采样时间；100 kΩ + 33 kΩ 的并联阻抗约 25 kΩ，建议采样时间 239.5 周期。

### 0x33 光敏/热敏电阻

光敏电阻（GL5528）和 NTC 热敏电阻都是“阻值随环境变化”，用固定电阻分压即可：

```text
VIN = 3.3 × R_fixed / (R_sensor + R_fixed)
```

NTC 是负温度系数，温度升高阻值下降；要得到温度，需要查表或解 Steinhart-Hart 方程，简单场合用分段线性查表就够。

### 0x34 输入保护与参考电压

- 输入电压不能超过 VDDA 或低于 VSSA；超了会通过保护二极管灌电流，长期会损坏。
- 输入加**限流电阻 + 钳位二极管**（BAT54S 到 3.3 V/GND）做保护。
- 高阻信号加**电压跟随器**（运放）降低源阻抗。
- VDDA/VREF 加 100 nF + 10 µF 滤波，远离电机、继电器等干扰源。
- 模拟地和数字地单点连接，ADC 走线远离高频信号。

## 0x40 软件设计

本篇代码文件：

| 文件 | 作用 |
| ---- | ---- |
| `AD.h` / `AD.c` | 单通道轮询 + 平均 + 电压换算 |
| `AD_DMA.h` / `AD_DMA.c` | 四通道扫描 + DMA |
| `main.c` | 实验主程序（OLED 显示） |

### 0x41 初始化顺序

单通道采集的固定套路：

1. 开 ADC1 时钟（APB2）和 GPIO 时钟（APB2）；
2. 配 ADCCLK 分频（≤14 MHz）；
3. 把引脚配成 `GPIO_Mode_AIN`（模拟输入）；
4. 配规则组通道、排名、采样时间；
5. 配 ADC 模式（独立、右对齐、单次/连续、扫描、通道数）；
6. 使能 ADC，做校准；
7. 启动转换，等 EOC，读 DR。

顺序不能乱：先配时钟再配外设，先校准再转换。

### 0x42 单通道（轮询）完整代码

`AD.h`：

```c
#ifndef __AD_H
#define __AD_H

#include "stm32f10x.h"

void AD_Init(void);
uint16_t AD_GetValue(void);
uint16_t AD_GetAverage(uint8_t Times);
uint16_t AD_GetVoltage_mV(void);

#endif
```

`AD.c`：

```c
#include "AD.h"

void AD_Init(void)
{
    /* 1. 时钟 */
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_ADC1, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    /* 2. ADCCLK = 72MHz / 6 = 12MHz（≤14MHz） */
    RCC_ADCCLKConfig(RCC_PCLK2_Div6);

    /* 3. PA0 模拟输入 */
    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AIN;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_0;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    /* 4. 规则组：通道 0，排第 1 个，采样 55.5 周期 */
    ADC_RegularChannelConfig(ADC1, ADC_Channel_0, 1, ADC_SampleTime_55Cycles5);

    /* 5. ADC 参数 */
    ADC_InitTypeDef ADC_InitStructure;
    ADC_InitStructure.ADC_Mode = ADC_Mode_Independent;
    ADC_InitStructure.ADC_DataAlign = ADC_DataAlign_Right;
    ADC_InitStructure.ADC_ExternalTrigConv = ADC_ExternalTrigConv_None;
    ADC_InitStructure.ADC_ContinuousConvMode = DISABLE;
    ADC_InitStructure.ADC_ScanConvMode = DISABLE;
    ADC_InitStructure.ADC_NbrOfChannel = 1;
    ADC_Init(ADC1, &ADC_InitStructure);

    /* 6. 使能 + 校准 */
    ADC_Cmd(ADC1, ENABLE);

    ADC_ResetCalibration(ADC1);
    while (ADC_GetResetCalibrationStatus(ADC1) == SET);

    ADC_StartCalibration(ADC1);
    while (ADC_GetCalibrationStatus(ADC1) == SET);
}

uint16_t AD_GetValue(void)
{
    ADC_SoftwareStartConvCmd(ADC1, ENABLE);
    while (ADC_GetFlagStatus(ADC1, ADC_FLAG_EOC) == RESET);

    return ADC_GetConversionValue(ADC1);   /* 读 DR，自动清 EOC */
}

uint16_t AD_GetAverage(uint8_t Times)
{
    uint32_t Sum = 0;

    for (uint8_t i = 0; i < Times; i++)
    {
        Sum += AD_GetValue();
    }

    return Sum / Times;
}

uint16_t AD_GetVoltage_mV(void)
{
    /* 3300mV × CODE / 4095，整数运算 */
    return (uint32_t)AD_GetAverage(8) * 3300 / 4095;
}
```

`main.c`：

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "OLED.h"
#include "AD.h"

int main(void)
{
    uint16_t Code;
    uint16_t mV;

    OLED_Init();
    AD_Init();

    OLED_ShowString(1, 1, "CODE:");
    OLED_ShowString(2, 1, "Volt:0.000V");

    while (1)
    {
        Code = AD_GetAverage(8);
        mV = (uint32_t)Code * 3300 / 4095;

        OLED_ShowNum(1, 6, Code, 4);
        OLED_ShowNum(2, 6, mV / 1000, 1);
        OLED_ShowString(2, 7, ".");
        OLED_ShowNum(2, 8, mV % 1000, 3);

        Delay_ms(100);
    }
}
```

### 0x43 多通道 + DMA 完整代码

规则组只有一个 DR，4 个通道必须让 DMA 在每次 EOC 后搬走。`AD.h`：

```c
#ifndef __AD_H
#define __AD_H

#include "stm32f10x.h"

extern uint16_t AD_Value[4];

void AD_Init(void);

#endif
```

`AD.c`：

```c
#include "AD.h"

uint16_t AD_Value[4];

void AD_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_ADC1, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1, ENABLE);
    RCC_ADCCLKConfig(RCC_PCLK2_Div6);

    /* PA0 ~ PA3 四个模拟输入 */
    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AIN;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_0 | GPIO_Pin_1 | GPIO_Pin_2 | GPIO_Pin_3;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    /* 规则序列：通道 0~3，排第 1~4 个 */
    ADC_RegularChannelConfig(ADC1, ADC_Channel_0, 1, ADC_SampleTime_55Cycles5);
    ADC_RegularChannelConfig(ADC1, ADC_Channel_1, 2, ADC_SampleTime_55Cycles5);
    ADC_RegularChannelConfig(ADC1, ADC_Channel_2, 3, ADC_SampleTime_55Cycles5);
    ADC_RegularChannelConfig(ADC1, ADC_Channel_3, 4, ADC_SampleTime_55Cycles5);

    ADC_InitTypeDef ADC_InitStructure;
    ADC_InitStructure.ADC_Mode = ADC_Mode_Independent;
    ADC_InitStructure.ADC_DataAlign = ADC_DataAlign_Right;
    ADC_InitStructure.ADC_ExternalTrigConv = ADC_ExternalTrigConv_None;
    ADC_InitStructure.ADC_ContinuousConvMode = ENABLE;   /* 连续 */
    ADC_InitStructure.ADC_ScanConvMode = ENABLE;         /* 扫描 */
    ADC_InitStructure.ADC_NbrOfChannel = 4;
    ADC_Init(ADC1, &ADC_InitStructure);

    ADC_DMACmd(ADC1, ENABLE);   /* ADC 发 DMA 请求 */

    /* DMA1 通道 1 固定用于 ADC1 */
    DMA_InitTypeDef DMA_InitStructure;
    DMA_InitStructure.DMA_PeripheralBaseAddr = (uint32_t)&ADC1->DR;
    DMA_InitStructure.DMA_MemoryBaseAddr = (uint32_t)AD_Value;
    DMA_InitStructure.DMA_DIR = DMA_DIR_PeripheralSRC;
    DMA_InitStructure.DMA_BufferSize = 4;
    DMA_InitStructure.DMA_PeripheralInc = DMA_PeripheralInc_Disable;
    DMA_InitStructure.DMA_MemoryInc = DMA_MemoryInc_Enable;
    DMA_InitStructure.DMA_PeripheralDataSize = DMA_PeripheralDataSize_HalfWord;
    DMA_InitStructure.DMA_MemoryDataSize = DMA_MemoryDataSize_HalfWord;
    DMA_InitStructure.DMA_Mode = DMA_Mode_Circular;
    DMA_InitStructure.DMA_Priority = DMA_Priority_Medium;
    DMA_InitStructure.DMA_M2M = DMA_M2M_Disable;
    DMA_Init(DMA1_Channel1, &DMA_InitStructure);
    DMA_Cmd(DMA1_Channel1, ENABLE);

    ADC_Cmd(ADC1, ENABLE);

    ADC_ResetCalibration(ADC1);
    while (ADC_GetResetCalibrationStatus(ADC1) == SET);
    ADC_StartCalibration(ADC1);
    while (ADC_GetCalibrationStatus(ADC1) == SET);

    ADC_SoftwareStartConvCmd(ADC1, ENABLE);   /* 启动一次，之后自动循环 */
}
```

`main.c`：

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "OLED.h"
#include "AD.h"

int main(void)
{
    OLED_Init();
    AD_Init();

    OLED_ShowString(1, 1, "AD0:");
    OLED_ShowString(2, 1, "AD1:");
    OLED_ShowString(3, 1, "AD2:");
    OLED_ShowString(4, 1, "AD3:");

    while (1)
    {
        OLED_ShowNum(1, 5, AD_Value[0], 4);
        OLED_ShowNum(2, 5, AD_Value[1], 4);
        OLED_ShowNum(3, 5, AD_Value[2], 4);
        OLED_ShowNum(4, 5, AD_Value[3], 4);
        Delay_ms(100);
    }
}
```

> DMA 循环模式下，`AD_Value` 会在后台被不断刷新；CPU 读的时候可能读到“半新半旧”的一组值。要求严格同步时，可以开 DMA 传输完成中断，或者用双缓冲。

### 0x44 注入组（紧急采样）

注入组不占用规则组的 DR，可以随时插队：

```c
void ADC_Injected_Init(void)
{
    ADC_InjectedChannelConfig(ADC1, ADC_Channel_1, 1, ADC_SampleTime_55Cycles5);

    /* 软件触发注入组：只靠 ADC_SoftwareStartInjectedConvCmd 启动，
       不需要 ADC_ExternalTrigInjectedConvConfig（也没有 NONE 这个常量） */
}

uint16_t ADC_GetInjected(void)
{
    ADC_SoftwareStartInjectedConvCmd(ADC1, ENABLE);
    while (ADC_GetFlagStatus(ADC1, ADC_FLAG_JEOC) == RESET);

    return ADC_GetInjectedConversionValue(ADC1, ADC_InjectedChannel_1);
}
```

注入组常配合定时器的 TRGO 做“电流环”采样，或者在电源跌落中断里立刻读一次电池电压。

### 0x45 内部温度与 Vrefint

```c
void Temp_Init(void)
{
    ADC_TempSensorVrefintCmd(ENABLE);   /* 打开温度 + VREFINT */
    ADC_RegularChannelConfig(ADC1, ADC_Channel_16, 1, ADC_SampleTime_239Cycles5);
}

float Temp_Get(void)
{
    uint16_t Code = AD_GetValue();
    float Voltage = Code * 3.3f / 4095.0f;

    return (1.43f - Voltage) / 0.0043f + 25.0f;
}

float VDD_Get(void)
{
    /* 先切到通道 17 读 VREFINT */
    ADC_RegularChannelConfig(ADC1, ADC_Channel_17, 1, ADC_SampleTime_239Cycles5);
    uint16_t Code = AD_GetValue();

    return 1.20f * 4095.0f / Code;
}
```

温度测的是芯片结温，不是环境温度，精度约 ±1.5°C，适合看趋势。

### 0x46 数字滤波

ADC 读数总会有噪声，最简单的三种滤波：

```c
/* 1. 多次平均：牺牲速度换稳定 */
uint16_t Filter_Average(void)
{
    uint32_t Sum = 0;
    for (uint8_t i = 0; i < 16; i++) Sum += AD_GetValue();
    return Sum / 16;
}

/* 2. 中值滤波：去掉偶发尖峰 */
uint16_t Filter_Median(void)
{
    uint16_t Buf[5];

    for (uint8_t i = 0; i < 5; i++) Buf[i] = AD_GetValue();

    /* 简单冒泡排序 */
    for (uint8_t i = 0; i < 4; i++)
        for (uint8_t j = 0; j < 4 - i; j++)
            if (Buf[j] > Buf[j + 1])
            {
                uint16_t t = Buf[j];
                Buf[j] = Buf[j + 1];
                Buf[j + 1] = t;
            }

    return Buf[2];
}

/* 3. 一阶低通：适合连续采样 */
uint16_t Filter_LowPass(uint16_t NewValue)
{
    static uint32_t Old = 0;
    Old = (Old * 7 + NewValue) / 8;   /* α = 1/8 */
    return Old;
}
```

### 0x47 定时器触发 + DMA（等间隔采样）

软件轮询的采样间隔由 `Delay` 和代码执行时间决定，抖动很大；要测波形、做 FFT，必须用**定时器 TRGO 触发 ADC**，让采样时刻严格等间隔：

```c
void AD_TimerTrigger_Init(void)
{
    /* 1. TIM3：72MHz / 7200 / 100 = 100Hz 触发 */
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM3, ENABLE);

    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStructure;
    TIM_TimeBaseInitStructure.TIM_ClockDivision = TIM_CKD_DIV1;
    TIM_TimeBaseInitStructure.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStructure.TIM_Period = 100 - 1;
    TIM_TimeBaseInitStructure.TIM_Prescaler = 7200 - 1;
    TIM_TimeBaseInitStructure.TIM_RepetitionCounter = 0;
    TIM_TimeBaseInit(TIM3, &TIM_TimeBaseInitStructure);

    /* 2. 更新事件作为 TRGO 输出 */
    TIM_SelectOutputTrigger(TIM3, TIM_TRGOSource_Update);
    TIM_Cmd(TIM3, ENABLE);

    /* 3. ADC 规则组触发源选 T3_TRGO：
          在 ADC_Init 之前设置下面这一行
          ADC_InitStructure.ADC_ExternalTrigConv = ADC_ExternalTrigConv_T3_TRGO;
          再调用 ADC_ExternalTrigConvCmd(ADC1, ENABLE) 打开外部触发 */
    ADC_ExternalTrigConvCmd(ADC1, ENABLE);

    /* 4. 注意：此时 ADC_Init 里 ContinuousConvMode 要 DISABLE，
          每次触发只转换一个序列；DMA 仍然循环搬运 */
}
```

配合 0x43 的扫描 + DMA，把 `ADC_ContinuousConvMode` 改成 `DISABLE`，就是“定时器等间隔采样 N 个点”的数据采集器：

```text
TIM3 每 10ms 产生 TRGO → ADC 转换 1 个通道 → DMA 搬到数组
```

采样率 = 定时器频率 = `72MHz / (PSC+1) / (ARR+1)`，与代码执行时间无关。要测 50 Hz 工频，采样率取 1 kHz；要测音频，采样率取 8 ~ 44.1 kHz，同时保证 `TCONV` 小于采样周期。

## 0x50 实验与调试

### 0x51 单通道实验

接线：电位器两端 3.3 V / GND，中间接 PA0。

预期：拧动电位器，OLED 上 `CODE` 从 0 到 4095 连续变化，电压从 0.000 V 到 3.300 V 左右。用万用表量 PA0 对地电压，和显示值对比，误差应在 ±0.02 V 内。

### 0x52 多通道实验

PA0 ~ PA3 分别接四个不同电压（电位器、分压电阻、3.3 V、GND），OLED 四行应分别显示对应值且互不串扰。如果四行数字一样，检查：

- 规则序列排名是否重复；
- DMA BufferSize 是否为 4；
- DMA 是否循环模式；
- 是否忘了 `ADC_DMACmd`。

### 0x53 采样时间对比

把电位器换成 100 kΩ，分别用 1.5、55.5、239.5 周期采样，记录 CODE：

| 采样时间 | 理论 | 实测 | 现象 |
| -------- | ---- | ---- | ---- |
| 1.5 | 偏低 | 偏低明显 | 电容没充满 |
| 55.5 | 接近 | 略低 | 基本可用 |
| 239.5 | 接近 | 最接近 | 高阻推荐 |

这个实验能直观看到“源阻抗 × 采样时间”的影响。

### 0x54 用串口看波形

OLED 只能看数字，想看趋势就用串口把数据发出来：

```c
printf("%d,%d\r\n", AD_Value[0], AD_Value[1]);
```

把波特率设成 115200，用串口助手的“绘图”功能，或者把数据存成 CSV 丢进 Excel/Python，就能看到电压随时间的变化。采样率 100 Hz 时，一串 `1000` 个点正好 10 秒。

### 0x55 噪声与布线

- 读数末位跳 ±3 个 LSB 属正常；
- 跳几十个 LSB：检查地线、VDDA 滤波、信号线是否靠近电机/继电器；
- 工频干扰（50 Hz）：采样率避开 50 Hz 整数倍，或加 100 ms 平均；
- 需要更高精度：外接基准源（如 REF3033）、用差分输入、做多点校准。

### 0x56 系统级校准与温漂

芯片自带的校准只解决“内部零点”，整个采集链（分压电阻、基准、运放）的误差要靠**两点校准**：

```c
/* 用标准源分别输入 V1、V2，记下 CODE1、CODE2 */
float k = (V2 - V1) / (CODE2 - CODE1);
float b = V1 - k * CODE1;

/* 之后每次读数 */
float voltage = k * Code + b;
```

校准要在**工作温度附近**做；分压电阻的温漂、基准的温漂都会让 `k` 随温度变化。要求高的场合用低温漂电阻（25 ppm/°C）、外部基准（REF3033），或者在工作温度范围内做多点校准表。

最后提醒一句：ADC 的“位数”只是硬件上限，真正决定读数可信度的是前端电路和校准。一个 12 位 ADC 配 1% 精度的分压电阻，系统精度不会超过 1%；反过来，前端做得好，10 位也能测得很稳。

## 0x60 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| 读数一直是 0 | 引脚没配 AIN、通道号错、ADC 没使能 | 检查 `GPIO_Mode_AIN`、`ADC_Channel_x` |
| 读数一直是 4095 | 输入接 3.3 V 或悬空被拉高 | 检查接线、加下拉 |
| 数值乱跳 | 参考电压噪声、源阻抗大、采样时间短 | 加滤波、加长采样、加跟随器 |
| 多通道只变最后一个 | 没开 DMA，DR 被覆盖 | 开 DMA 或每次读完再切通道 |
| 多通道数据错位 | 序列排名和 DMA 缓冲区顺序不一致 | 按排名顺序对应数组下标 |
| 校准不通过 | 校准前没使能 ADC | 先 `ADC_Cmd(ENABLE)` 再校准 |
| 温度读出来 0 或 100 | 没开 `ADC_TempSensorVrefintCmd` | 打开内部通道，采样 239.5 |
| 采样率上不去 | 采样时间太长、软件轮询开销 | 缩短采样、用连续+DMA、定时器触发 |
| 3.3 V 测出 3.2 V | 参考电压实际略低、校准偏差 | 用 VREFINT 反推 VDDA，或外接基准 |
| 电池分压后读数偏小 | 分压电阻太大、采样时间不够 | 加长采样或加运放跟随 |
| DMA 只搬一次 | 用了 Normal 模式 | 改 `DMA_Mode_Circular` |
| 注入组读不到 | 没开注入触发/没等 JEOC | 检查 `ADC_ExternalTrigInjectedConvCmd` |

## 0x70 小结

| 主题 | 关键点 |
| ---- | ------ |
| 原理 | SAR 二分搜索，12 次比较 |
| 分辨率 | 3.3 V / 4096 ≈ 0.806 mV，精度另算 |
| 采样 | fs ≥ 2fmax，源阻抗决定采样时间 |
| 结构 | 规则组 16 / 注入组 4，DR 共用 |
| 时间 | TCONV = 采样 + 12.5 周期，ADCCLK ≤ 14 MHz |
| 多通道 | 扫描 + 连续 + DMA 循环 |
| 校准 | 上电必做，先使能再校准 |
| 内部通道 | 温度 16、VREFINT 17，长采样 |

### 思考题

1. 为什么 12 位 ADC 的量化误差是 ±1/2 LSB，而不是 ±1 LSB？
2. 输入 10 kΩ 源阻抗、12 MHz ADCCLK 时，采样时间至少选多少？为什么？
3. 规则组 4 个通道、DMA 缓冲区 4 个半字，如果 `DMA_BufferSize` 写成 2 会发生什么？
4. 用 VREFINT 反推 VDDA 的原理是什么？它有什么前提？
5. 注入组和规则组同时触发时，转换顺序是怎样的？

ADC 本身的寄存器不多，难的是“采得准”：参考、源阻抗、采样时间、校准、布线，任何一项没处理好，12 位也只能当 8 位用。
