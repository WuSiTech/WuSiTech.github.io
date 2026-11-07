+++
title = "STM32 WDG：独立看门狗、窗口看门狗与任务监控"
date = "2026-11-06T19:30:00+08:00"
lastmod = "2026-11-06T23:59:00+08:00"
draft = false
description = "看门狗本质是“不喂就复位”的定时器。讲清 IWDG 的 LSI/12 位递减/键寄存器、WWDG 的窗口与 EWI，给出两套完整驱动、任务监控喂狗、调试冻结、低功耗注意事项与 12 条故障排查。"
categories = [ "STM32" ]
tags = [ "STM32", "WDG", "看门狗" ]
cover = "/images/pool/covers/covers-17.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 14 章（14-1、14-2）。

代码基于 **STM32F103C8T6 + STM32F10x 标准外设库 3.5.0**（API 已按 STM32F10x StdPeriph 3.5 头文件核对；Delay/OLED/Key 为课程配套驱动），不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 14-1 | 看门狗简介、IWDG、IWDG 键寄存器、超时时间、WWDG 框图、工作特性、超时/窗口、对比 | 0x00 ~ 0x30 |
| 14-2 | 独立看门狗、窗口看门狗（代码、实验） | 0x40 ~ 0x60 |

视频之外还补了：IWDG 低功耗行为、调试冻结、任务监控喂狗、窗口计算、复位标志、12 条故障排查。

## 0x00 为什么需要看门狗

![看门狗简介](/images/posts/stm32-wdg/wdg-intro.webp)

看门狗（Watchdog，WDG）本质是一个**定时器**：程序必须在规定时间内“喂狗”（重置计数器），否则硬件自动产生复位。

它解决的是“程序跑飞但没死透”的问题：

- 死循环；
- 数组越界/指针乱飞；
- 电磁干扰导致 PC 跳错；
- 某个任务卡死，主循环还在跑。

这些情况下程序不会自己恢复，但看门狗会把它拉回来。

### 0x01 看门狗能解决/不能解决什么

能解决：

- CPU 跑飞、HardFault 卡死；
- 主循环卡在某个等待；
- 中断风暴导致主循环饿死。

不能解决：

- 看门狗自己也被喂了（喂狗位置不对）；
- 外设配置错但程序还在跑；
- 电源/硬件故障；
- 数据错误（需要 CRC/校验）。

所以看门狗要配合“任务监控”和“异常记录”一起用。

### 0x02 适用场景与 FMEA

看门狗适合监控：

- 主循环是否在跑；
- 关键任务是否按时完成；
- 中断是否把 CPU 占死；
- 程序是否跑飞。

FMEA（失效模式分析）里，看门狗对应“CPU 异常”的缓解措施；它不能替代：

- 电源监控（PVD/外部监控）；
- 通信 CRC；
- 数据备份；
- 硬件看门狗（外部芯片）。

### 0x03 安全与误复位

看门狗本身也可能“误杀”：

- 初始化太慢，超时太短；
- 长耗时操作（Flash 擦除、EEPROM 写）；
- 低功耗休眠超过超时；
- 调试器暂停。

设计时要把“最坏执行时间”算进去，留足余量；误复位比不复位更烦人。

### 0x04 上电自检与看门狗

产品上电时先做自检（RAM/Flash/外设/传感器），自检期间也要喂狗：

```c
void PowerOn_SelfTest(void)
{
    IWDG_Feed();

    if (!RAM_Test())   Error_Handler();
    IWDG_Feed();

    if (!Sensor_Test()) Error_Handler();
    IWDG_Feed();
}
```

自检时间比正常业务长，超时要按“最坏自检时间”设计；否则一上电就反复复位。

### 0x05 看门狗与调试器

调试器（ST-LINK/J-Link）连着时：

- 暂停会触发看门狗复位；
- SWD 引脚本身耗电；
- 有些调试器会复位芯片。

调试阶段建议：

- 先不启动看门狗；
- 或配置 DBGMCU 冻结；
- 测低功耗电流时拔掉调试器。

## 0x10 两种看门狗

| 看门狗 | 时钟 | 特点 |
| ------ | ---- | ---- |
| IWDG 独立看门狗 | LSI（约 40 kHz） | 独立于主时钟，主时钟挂了也能复位；时间精度低 |
| WWDG 窗口看门狗 | PCLK1（36 MHz） | 要求喂狗落在“窗口”内，太早太晚都复位；精度高 |

选择：

- 只要“程序卡死能复位”——IWDG；
- 还要抓“程序跑太快/跳过步骤”——WWDG；
- 高可靠系统可以两个都用。

## 0x20 独立看门狗 IWDG

![IWDG 框图](/images/posts/stm32-wdg/iwdg-block.webp)

结构：

- 时钟：**LSI 40 kHz**（内部 RC，不受主时钟影响）；
- **8 位预分频器**：4 / 8 / 16 / 32 / 64 / 128 / 256；
- **12 位递减计数器**：从重装值往下数，数到 0 就复位；
- 重装寄存器 `IWDG_RLR`、键寄存器 `IWDG_KR`、状态寄存器 `IWDG_SR`。

### 0x21 键寄存器

IWDG 没有普通的“控制寄存器”，而是用**写特定值**来操作：

| 写入 IWDG_KR | 作用 |
| ------------ | ---- |
| 0xCCCC | 启动独立看门狗 |
| 0xAAAA | 喂狗（把 RLR 重装进计数器） |
| 0x5555 | 解除 PR/RLR 的写保护 |
| 其它值 | 重新开启写保护 |

初始化顺序：`0x5555` 解锁 → 写 PR/RLR → `0xAAAA` 装初值 → `0xCCCC` 启动。

### 0x22 超时时间

```text
TIWDG = (1 / LSI) × 预分频 × (RL + 1)
```

LSI 取 40 kHz：

| 预分频 | 1 个计数 | 最大超时（RL=4095） |
| ------ | -------- | ------------------- |
| 4 | 0.1 ms | 409.6 ms |
| 8 | 0.2 ms | 819.2 ms |
| 16 | 0.4 ms | 1.638 s |
| 32 | 0.8 ms | 3.277 s |
| 64 | 1.6 ms | 6.553 s |
| 128 | 3.2 ms | 13.1 s |
| 256 | 6.4 ms | 26.2 s |

LSI 实际频率在 30 ~ 60 kHz 之间漂移，超时误差可能 ±50%，**不能拿它做精确计时**。

### 0x23 启动与喂狗

```c
IWDG_WriteAccessCmd(IWDG_WriteAccess_Enable);   /* 0x5555 */
IWDG_SetPrescaler(IWDG_Prescaler_64);
IWDG_SetReload(625);                            /* 1s */
IWDG_ReloadCounter();                           /* 0xAAAA */
IWDG_Enable();                                  /* 0xCCCC */
```

一旦启动，**不能关**（只能复位后重新配置）。所以调试时要么先不启动，要么用调试器冻结。

### 0x24 低功耗行为

- IWDG 由 LSI 驱动，**Stop/Standby 下仍然计数**；
- 进 Stop 前要么保证在超时内唤醒，要么先关掉（但 IWDG 启动后关不掉，只能复位）；
- 长休眠设备一般用 RTC 唤醒 + 每次醒来喂狗，或者不用 IWDG 改用外部看门狗。

### 0x25 寄存器级操作

不看库函数，直接操作寄存器：

```c
void IWDG_Init_Reg(uint16_t Reload)
{
    IWDG->KR = 0x5555;          /* 解锁 PR/RLR */
    IWDG->PR = 4;               /* 64 分频 */
    IWDG->RLR = Reload;         /* 重装值 */
    IWDG->KR = 0xAAAA;          /* 喂狗 */
    IWDG->KR = 0xCCCC;          /* 启动 */
}

void IWDG_Feed_Reg(void)
{
    IWDG->KR = 0xAAAA;
}
```

状态寄存器 `IWDG_SR` 的 PVU/RVU 位表示“预分频/重装值正在更新”，改参数后要等它们清零再继续。

### 0x26 LSI 精度与校准

LSI 是内部 RC，手册给的范围通常是 30 ~ 60 kHz（25 °C 典型 40 kHz），温度漂移大。

- 用它做看门狗没问题（只要超时留足余量）；
- 用它做 RTC 会走不准；
- 需要精确时，用 LSE 或外部看门狗芯片。

如果一定要用 LSI 做时间基准，可以先用 HSE 测出实际频率，再算分频（见 RTC 篇）。

### 0x27 启动时间

IWDG 启动后，计数器从 RLR 开始递减；从“写 0xCCCC”到“第一次可能复位”的时间就是超时时间。初始化后要**尽快喂第一次**，避免配置期间超时。

### 0x28 初始化顺序与陷阱

正确顺序：

```text
开 LSI（IWDG 硬件自动开）→ 解锁 → 设 PR → 设 RLR → 喂一次 → 启动
```

常见陷阱：

- 先启动后设 RLR：启动时用的是默认值，可能立刻复位；
- 设完 RLR 没喂：计数器还是旧值；
- 在中断里初始化：中断延迟导致超时；
- 调试时初始化：调试器暂停导致复位。

### 0x29 IWDG 与低功耗的取舍

低功耗设备常问：“能不能休眠时关掉 IWDG？”

- IWDG 启动后不能关，只能复位；
- 休眠时间必须小于超时，或者用外部看门狗；
- 有些型号支持 `IWDG_STOP` 调试冻结，但那是调试用，不是低功耗。

所以设计低功耗时，要么把超时设得足够长（26 s），要么用可关的外部看门狗。

### 0x2A 常用超时速查

LSI 按 40 kHz、预分频 64（1 个计数 1.6 ms）：

| 目标超时 | RLR |
| -------- | --- |
| 100 ms | 62 |
| 200 ms | 125 |
| 500 ms | 312 |
| 1 s | 625 |
| 2 s | 1250 |
| 5 s | 3125 |
| 10 s | 4095（约 6.5 s 上限，需换预分频） |

超过 6.5 s 要换更大的预分频（128/256）。

### 0x2B IWDG 与 RTC 唤醒

“RTC 唤醒 + IWDG”组合：

- IWDG 超时设 2 s；
- RTC 每 1 s 唤醒一次喂狗；
- 这样即使主循环卡死，RTC 中断还能喂——但这会掩盖问题，不推荐；
- 正确做法：RTC 唤醒后让主循环处理，处理完再喂。

看门狗要监控“业务”，不是“中断还活着”。

## 0x30 窗口看门狗 WWDG

![WWDG 框图](/images/posts/stm32-wdg/wwdg-block.webp)

WWDG 比 IWDG 多一个“窗口”：

- 时钟：PCLK1（36 MHz），经 4096 分频再可选 1/2/4/8；
- 7 位递减计数器 `T[6:0]`；
- 窗口寄存器 `W[6:0]`；
- 当 `T[6:0]` 从 0x40 递减到 0x3F 时复位；
- **喂狗时如果 `T[6:0] > W[6:0]`，也会立刻复位**；
- 计数器减到 0x40 时可以产生 **EWI 提前唤醒中断**。

所以 WWDG 要求“不能太晚喂，也不能太早喂”：喂狗必须发生在计数器降到窗口值之后、降到 0x3F 之前。这能抓住“程序跑得太快、跳过了某些步骤”的异常。

### 0x31 超时与窗口

```text
TWWDG = (1 / PCLK1) × 4096 × 预分频 × (T[6:0] - 0x3F)
```

PCLK1 = 36 MHz、预分频 8 时，一个计数约 0.91 ms：

| 初值 | 到 0x3F 的时间 |
| ---- | -------------- |
| 0x7F | 约 58 ms |
| 0x6F | 约 44 ms |
| 0x5F | 约 29 ms |
| 0x4F | 约 15 ms |

窗口值 `W[6:0]` 必须大于 0x3F，小于等于初始计数值。比如初值 0x7F、窗口 0x5F，就要求计数器降到 0x5F 以下才能喂狗。

### 0x32 工作特性

- 递减计数器 T6:0 小于 0x40 时，WWDG 产生复位；
- T6:0 在窗口 W6:0 之外被重新装载时，WWDG 产生复位；
- T6:0 等于 0x40 时可以产生早期唤醒中断 EWI；
- 定期写入 WWDG_CR 喂狗，避免复位。

### 0x33 EWI 提前唤醒

EWI 在计数器到 0x40 时触发，给软件一个“最后保存/恢复”的窗口：

```c
void WWDG_IRQHandler(void)
{
    if (WWDG_GetFlagStatus() == SET)
    {
        WWDG_ClearFlag();
        /* 保存关键数据 */
        WWDG_SetCounter(0x7F);   /* 再喂一次，避免立刻复位 */
    }
}
```

EWI 不是“无限续命”，只是最后的保存窗口；保存完还是要让系统正常复位或恢复。

### 0x34 窗口计算示例

PCLK1 = 36 MHz、WDGTB = 8、初值 0x7F、窗口 0x5F：

```text
每个计数 = 4096 × 8 / 36MHz ≈ 0.91 ms
从 0x7F 到 0x3F：64 × 0.91 ≈ 58 ms
从 0x5F 到 0x3F：32 × 0.91 ≈ 29 ms
```

所以喂狗必须落在“进入循环后 29 ~ 58 ms”之间。太早（<29 ms）或太晚（>58 ms）都复位。

### 0x35 IWDG 与 WWDG 同时用

高可靠系统可以：

- IWDG 管“整体卡死”（超时 1 s）；
- WWDG 管“关键任务时序”（窗口 20 ~ 40 ms）。

两个都喂，任何一个出问题都会复位。注意调试时两个都要冻结。

### 0x36 WWDG 寄存器级

```c
void WWDG_Init_Reg(uint8_t Window, uint8_t Counter)
{
    RCC->APB1ENR |= RCC_APB1ENR_WWDGEN;

    WWDG->CFR = (WWDG->CFR & ~0x7F) | (Window & 0x7F);
    WWDG->CFR |= 0x01 << 7;     /* EWI 使能 */
    WWDG->CR = (Counter & 0x7F) | 0x80;   /* WDGA=1，启动 */
}
```

`WWDG_CR` 的 bit7 是 WDGA（激活），低 7 位是计数器；`WWDG_CFR` 的 bit7 是 EWI，bit8~9 是 WDGTB。

### 0x37 电机控制里的 WWDG

电机控制要求“控制周期严格定时”：如果某个周期算太久，PWM 更新就会延迟，可能烧管。WWDG 的窗口正好能抓“周期太短/太长”：

- 正常：每个控制周期结束喂一次；
- 周期被跳过：计数器掉到 0x3F 复位；
- 周期异常快（中断嵌套错）：喂狗太早复位。

比 IWDG 更适合“硬实时”场景。

### 0x38 喂狗的几种写法

```c
/* 1. 主循环喂（最简单，但监控弱） */
while (1) { Task(); IWDG_Feed(); }

/* 2. 定时器中断喂（不推荐，主循环死了也喂） */
void TIM_IRQHandler(void) { IWDG_Feed(); }

/* 3. 任务打卡 + 监控任务喂（推荐） */
if (TaskFlags == ALL) { IWDG_Feed(); TaskFlags = 0; }
```

### 0x3A WWDG 与 PWM 保护

电机控制里，PWM 更新依赖控制周期。如果控制任务卡死，PWM 可能保持在一个危险占空比。

组合方案：

- WWDG 监控控制周期；
- 一旦超时复位，PWM 引脚回到复位默认（高阻/低电平）；
- 硬件上再加“刹车/使能”引脚，复位时自动关断。

软件只能“尽力”，真正的安全要靠硬件（刹车输入 BKIN、外部逻辑）。

### 0x3B 看门狗与 DMA 长传输

DMA 搬大块数据时 CPU 空闲，主循环可能“看起来还在跑”，但实际业务没完成。喂狗要等 DMA 完成标志：

```c
DMA_Cmd(DMA1_Channel3, ENABLE);
while (DMA_GetFlagStatus(DMA1_FLAG_TC3) == RESET)
{
    IWDG_Feed();     /* 传输期间喂狗，但别掩盖卡死 */
}
```

更好的做法是“DMA 完成中断置标志，主循环检查标志后喂狗”，避免“传输卡住但看门狗被喂”。

## 0x40 代码实现

本篇代码文件：

| 文件 | 作用 |
| ---- | ---- |
| `IWDG.h` / `IWDG.c` | 独立看门狗初始化/喂狗 |
| `WWDG.h` / `WWDG.c` | 窗口看门狗初始化/喂狗/EWI |
| `Monitor.c` | 多任务喂狗监控 |
| `main.c` | 实验主程序 |

### 0x41 独立看门狗（约 1 s）

`IWDG.h`：

```c
#ifndef __IWDG_H
#define __IWDG_H

#include "stm32f10x.h"

void IWDG_Init(uint16_t Reload);
void IWDG_Feed(void);

#endif
```

`IWDG.c`：

```c
#include "IWDG.h"

void IWDG_Init(uint16_t Reload)
{
    /* 40kHz / 64 = 625Hz，一个计数 1.6ms */
    IWDG_WriteAccessCmd(IWDG_WriteAccess_Enable);
    IWDG_SetPrescaler(IWDG_Prescaler_64);
    IWDG_SetReload(Reload);
    IWDG_ReloadCounter();
    IWDG_Enable();
}

void IWDG_Feed(void)
{
    IWDG_ReloadCounter();
}
```

`main.c`：

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "LED.h"
#include "Key.h"
#include "IWDG.h"

int main(void)
{
    LED_Init();
    Key_Init();

    IWDG_Init(625);   /* 625 × 1.6ms ≈ 1s */

    while (1)
    {
        LED_Toggle();
        Delay_ms(200);

        if (Key_GetNum() == 1)
        {
            /* 模拟程序卡死：不再喂狗 */
            while (1);
        }

        IWDG_Feed();
    }
}
```

现象：正常时 LED 一直闪；按下按键后约 1 s 芯片复位，LED 重新开始闪。

### 0x42 窗口看门狗（约 50 ms）

`WWDG.h`：

```c
#ifndef __WWDG_H
#define __WWDG_H

#include "stm32f10x.h"

void WWDG_Init(uint8_t Window, uint8_t Counter);
void WWDG_Feed(void);

#endif
```

`WWDG.c`：

```c
#include "WWDG.h"

void WWDG_Init(uint8_t Window, uint8_t Counter)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_WWDG, ENABLE);

    WWDG_SetPrescaler(WWDG_Prescaler_8);
    WWDG_SetWindowValue(Window);
    WWDG_Enable(Counter);

    WWDG_ClearFlag();
    WWDG_EnableIT();
}

void WWDG_Feed(void)
{
    WWDG_SetCounter(0x7F);
}
```

`main.c`：

```c
int main(void)
{
    LED_Init();
    WWDG_Init(0x5F, 0x7F);   /* 窗口 0x5F，初值 0x7F */

    while (1)
    {
        LED_Toggle();
        Delay_ms(20);

        /* 必须在计数器降到 0x5F 之后、0x3F 之前喂 */
        WWDG_Feed();
    }
}
```

如果延时太短（比如 1 ms 就喂），计数器还没降到 0x5F，会立刻复位——这就是“窗口”的作用。

### 0x43 EWI 中断

```c
void WWDG_IRQHandler(void)
{
    if (WWDG_GetFlagStatus() == SET)
    {
        WWDG_ClearFlag();
        /* 记录错误、保存状态 */
        WWDG_SetCounter(0x7F);
    }
}
```

### 0x44 多任务喂狗监控

主循环喂狗容易“某个任务死了但主循环还在喂”。更稳的做法是“任务打卡，喂狗检查”：

```c
volatile uint8_t TaskFlags;

void Task1(void)
{
    /* 业务代码 */
    TaskFlags |= 0x01;
}

void Task2(void)
{
    /* 业务代码 */
    TaskFlags |= 0x02;
}

void Monitor_Task(void)
{
    if (TaskFlags == 0x03)     /* 两个任务都跑过 */
    {
        IWDG_Feed();
        TaskFlags = 0;
    }
}
```

如果某个任务卡死，`TaskFlags` 永远凑不齐，看门狗就会复位。喂狗周期要小于 IWDG 超时，且监控任务本身要能被调度到。

### 0x45 调试时冻结看门狗

调试器暂停时，IWDG/WWDG 还在跑，会一直复位。可以配置 DBGMCU 冻结：

```c
RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);
DBGMCU_Config(DBGMCU_IWDG_STOP, ENABLE);
DBGMCU_Config(DBGMCU_WWDG_STOP, ENABLE);
```

这样只在调试器暂停时冻结，正常运行不受影响。发布版可以保留，也可以去掉。

### 0x46 复位后判断原因

```c
if (RCC_GetFlagStatus(RCC_FLAG_IWDGRST) == SET)
{
    /* 上次是 IWDG 复位 */
}
if (RCC_GetFlagStatus(RCC_FLAG_WWDGRST) == SET)
{
    /* 上次是 WWDG 复位 */
}
RCC_ClearFlag();
```

配合 BKP 记录“复位次数/最后任务”，能定位“为什么老复位”。

### 0x47 低功耗 + 看门狗完整流程

```c
void LowPower_Loop(void)
{
    while (1)
    {
        /* 1. 醒着：采样、发送 */
        Sensor_Read();
        Radio_Send();

        /* 2. 喂狗 */
        IWDG_Feed();

        /* 3. 设 RTC 闹钟，休眠 */
        RTC_SetAlarm(RTC_GetCounter() + 10);
        RTC_WaitForLastTask();

        PWR_EnterSTOPMode(PWR_Regulator_LowPower, PWR_STOPEntry_WFI);

        /* 4. 唤醒后重配时钟 */
        SystemInit();
        Serial_Init();
    }
}
```

要点：

- 休眠时间必须小于 IWDG 超时，否则睡着睡着就复位；
- 唤醒后第一件事是喂狗 + 重配时钟；
- 如果休眠时间可能很长，改用外部看门狗（可关）或不用 IWDG。

### 0x48 看门狗与 RTOS

RTOS 里每个任务都可能卡死，喂狗要放在“监控任务”里：

```c
void MonitorTask(void *pv)
{
    while (1)
    {
        if (TaskFlag1 && TaskFlag2 && TaskFlag3)
        {
            IWDG_Feed();
            TaskFlag1 = TaskFlag2 = TaskFlag3 = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
```

- 业务任务定期置位自己的标志；
- 监控任务检查所有标志；
- 任何任务卡死，标志凑不齐，看门狗复位。

不要用“空闲钩子”喂狗——空闲任务优先级最低，忙的时候反而喂不到。

### 0x49 外部看门狗芯片

常见型号：TPS3823、MAX6369、CAT823。特点：

- 独立时钟，不受 MCU 影响；
- 超时可配（几十 ms ~ 几秒）；
- 有的支持“喂狗窗口”和“复位延时”；
- 通过一个 GPIO 输出 WDI 方波喂狗。

```c
void EXT_WDG_Feed(void)
{
    GPIO_SetBits(GPIOA, GPIO_Pin_8);
    Delay_us(10);
    GPIO_ResetBits(GPIOA, GPIO_Pin_8);
}
```

MCU 死机时 GPIO 不再翻转，外部芯片就会拉低 NRST。比内部看门狗更可靠，但多一颗芯片、多一个引脚。

### 0x4A Bootloader 中的看门狗

Bootloader 擦写 Flash 可能耗时几秒，超过 IWDG 超时就会复位。做法：

```c
for (uint32_t page = 0; page < PAGE_COUNT; page++)
{
    FLASH_ErasePage(APP_ADDR + page * 1024);
    IWDG_Feed();                 /* 每页喂一次 */
}

for (uint32_t i = 0; i < LEN; i += 256)
{
    FLASH_ProgramHalfWord(...);
    if ((i % 1024) == 0) IWDG_Feed();
}
```

跳转到 APP 前要确保 APP 会继续喂狗；如果 APP 不喂，IWDG 会在超时后复位。两边要约定同一个超时时间。

### 0x4B 双看门狗

```c
void WDG_All_Init(void)
{
    IWDG_Init(625);              /* 1s，防整体卡死 */
    WWDG_Init(0x5F, 0x7F);       /* 58ms，防时序错乱 */
}

void WDG_All_Feed(void)
{
    WWDG_Feed();                 /* 先喂窗口狗 */
    IWDG_Feed();
}
```

注意两个超时差一个数量级，窗口狗更严格；喂狗顺序和周期要设计好，别互相拖累。

### 0x4C 通信超时 + 看门狗

串口/无线等待应答时，如果死等会卡住主循环，看门狗复位。正确做法是“带超时的等待”：

```c
uint8_t Wait_Ack(uint32_t TimeoutMs)
{
    while (TimeoutMs--)
    {
        if (AckFlag) return 1;
        IWDG_Feed();          /* 等待期间喂狗 */
        Delay_ms(1);
    }
    return 0;
}
```

或者用状态机 + 定时器，避免阻塞。核心原则：**任何可能长时间等待的地方，都要么喂狗，要么非阻塞**。

### 0x4D 看门狗与低功耗定时器

F103 没有 LPTIM，低功耗定时靠 RTC。做“每 10 秒醒一次”的设备：

- 休眠时间必须 < IWDG 超时；
- 或者休眠前把 IWDG 超时设到最大（26 s）；
- 或者用外部看门狗（可关）。

### 0x4E 喂狗策略对比

| 策略 | 能发现什么 | 缺点 |
| ---- | ---------- | ---- |
| 主循环喂 | 整体卡死 | 单任务卡死发现不了 |
| 定时器中断喂 | 几乎发现不了 | 主循环死了也喂 |
| 任务打卡 | 单任务卡死 | 需要设计标志 |
| 窗口看门狗 | 时序过快/过慢 | 窗口要调 |
| 外部看门狗 | MCU 完全死机 | 多一颗料 |

推荐：**任务打卡 + IWDG**，关键时序再加 WWDG。

## 0x50 设计与调试

### 0x51 喂狗位置

- 放在**关键任务确实完成之后**；
- 不要放在定时器中断里无条件喂；
- 不要放在“最容易跑到”的地方（比如空循环）；
- 喂狗周期留 30% ~ 50% 余量。

### 0x52 超时怎么选

- 大于“最坏情况下的主循环时间”；
- 小于“用户能接受的最大卡死时间”；
- 有长耗时操作（Flash 擦除、EEPROM 写）时，要么分段喂，要么临时延长。

### 0x53 窗口怎么选

- 窗口值 = 期望的“最早喂狗时刻”；
- 太窄容易误复位，太宽失去意义；
- 先用逻辑分析仪/示波器看实际喂狗间隔，再定窗口。

### 0x54 低功耗与看门狗

- IWDG 在 Stop/Standby 仍计数；
- 长时间休眠要在唤醒后立刻喂，或缩短休眠；
- 不用 IWDG 时，可以用外部看门狗芯片（带独立时钟）。

### 0x55 用 GPIO 测喂狗间隔

```c
IWDG_Feed();
GPIO_SetBits(GPIOA, GPIO_Pin_5);
GPIO_ResetBits(GPIOA, GPIO_Pin_5);
```

示波器量高电平间隔，确认实际喂狗周期 < 超时时间的 70%。

### 0x56 调试技巧

- 先不启动看门狗，把业务跑通；
- 启动后先用长超时（如 5 s），稳定后再缩短；
- 用 DBGMCU 冻结，避免调试时反复复位；
- 复位后打印 `RCC_CSR` 标志；
- 用 BKP 记录复位次数和“最后运行的任务号”。

### 0x57 看门狗测试用例

| 用例 | 操作 | 预期 |
| ---- | ---- | ---- |
| 正常 | 按时喂狗 | 不复位 |
| 卡死 | 停止喂狗 | 超时复位 |
| 太早喂 | 窗口内提前喂 | WWDG 复位 |
| 太晚喂 | 超过窗口 | WWDG 复位 |
| 中断风暴 | 高频中断占满 CPU | 看情况（喂狗任务能否运行） |
| 低功耗 | 休眠超过超时 | 复位 |
| 复位恢复 | 复位后读标志 | 能识别 IWDG/WWDG |

### 0x58 复位后的恢复策略

看门狗复位后，不要“默默重跑”，要做：

1. 读复位标志，记录到 BKP/日志；
2. 进入安全状态（关输出、停机）；
3. 判断是否可以重试（连续复位 N 次就停机报警）；
4. 恢复正常后清标志。

```c
void Safe_Start(void)
{
    uint16_t Count = BKP_ReadBackupRegister(BKP_DR1);

    if (Count > 5)
    {
        /* 连续复位太多次，进入安全模式 */
        while (1)
        {
            LED_Blink(1);
        }
    }

    BKP_WriteBackupRegister(BKP_DR1, Count + 1);
    /* 正常运行后定期清零 */
}
```

### 0x59 看门狗日志

把“复位次数、最后一次任务号、时间戳”写进 BKP/Flash：

```c
BKP_WriteBackupRegister(BKP_DR3, LastTaskId);
BKP_WriteBackupRegister(BKP_DR4, ResetCount);
```

售后拿到设备，读 BKP 就能知道“复位前在跑哪个任务”。

### 0x5A 误复位排查流程

```text
1. 读 RCC_CSR：是 IWDG/WWDG/上电/软件？
2. IWDG：量实际喂狗间隔 vs 超时
3. 查长耗时：Flash 擦除、EEPROM 写、打印、延时
4. 查中断：是否有高优先级中断长时间占用
5. 查低功耗：休眠是否超过超时
6. 查电源：电压跌落会不会触发 BOR
7. 查调试器：是不是调试时暂停导致
```

按这个顺序，90% 的“莫名复位”都能定位。

### 0x5B 看门狗与日志系统

把“复位原因、复位次数、最后任务、运行时长”写进 BKP/Flash：

```c
typedef struct
{
    uint16_t ResetCount;
    uint16_t LastTask;
    uint32_t UpTime;
    uint16_t Reason;
} WdgLog;

void WdgLog_Save(WdgLog *Log)
{
    BKP_WriteBackupRegister(BKP_DR3, Log->ResetCount);
    BKP_WriteBackupRegister(BKP_DR4, Log->LastTask);
    BKP_WriteBackupRegister(BKP_DR5, Log->UpTime & 0xFFFF);
    BKP_WriteBackupRegister(BKP_DR6, Log->UpTime >> 16);
    BKP_WriteBackupRegister(BKP_DR7, Log->Reason);
}
```

售后读出来就能判断“是看门狗复位还是掉电”“复位前在跑什么”。

## 0x60 实验与调试

### 0x61 IWDG 超时实验

- 正常喂狗：LED 一直闪；
- 按键停止喂狗：约 1 s 后复位；
- 改 `Reload` 为 125：约 0.2 s 复位，验证公式。

### 0x62 WWDG 窗口实验

- 正常间隔（20 ms）喂：正常；
- 改成 1 ms 喂：立刻复位（太早）；
- 改成 100 ms 喂：复位（太晚）。

### 0x63 EWI 实验

在 EWI 中断里翻转一个 GPIO，示波器看“EWI 到复位”的时间窗口。

### 0x64 复位次数统计

用 BKP 记录复位次数：

```c
uint16_t Count = BKP_ReadBackupRegister(BKP_DR1);
BKP_WriteBackupRegister(BKP_DR1, Count + 1);
```

运行一天后看计数，能判断系统稳定性。

### 0x65 复位日志

把复位原因和次数记在 BKP，现场出问题能回溯：

```c
void Reset_Log(void)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_PWR, ENABLE);
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_BKP, ENABLE);
    PWR_BackupAccessCmd(ENABLE);

    uint16_t Count = BKP_ReadBackupRegister(BKP_DR1);
    BKP_WriteBackupRegister(BKP_DR1, Count + 1);

    if (RCC_GetFlagStatus(RCC_FLAG_IWDGRST) == SET)
    {
        BKP_WriteBackupRegister(BKP_DR2, 0x0001);   /* IWDG */
    }
    else if (RCC_GetFlagStatus(RCC_FLAG_WWDGRST) == SET)
    {
        BKP_WriteBackupRegister(BKP_DR2, 0x0002);   /* WWDG */
    }
    else if (RCC_GetFlagStatus(RCC_FLAG_PORRST) == SET)
    {
        BKP_WriteBackupRegister(BKP_DR2, 0x0003);   /* 上电 */
    }

    RCC_ClearFlag();
}
```

### 0x66 现场案例：频繁复位

- 现象：设备运行几小时后复位，日志显示 IWDG；
- 排查：喂狗在主循环，但某次 Flash 擦除耗时 2 s，超过 1 s 超时；
- 结论：长耗时操作分段喂狗，或临时延长超时；
- 改进：擦除按扇区做，每扇区之间喂一次。

另一个案例：

- 现象：WWDG 偶发复位；
- 排查：喂狗任务被高优先级中断抢占，间隔抖动；
- 结论：窗口留余量，喂狗任务优先级提高。

### 0x67 设计检查表

| 检查项 | 是/否 |
| ------ | ----- |
| 喂狗在关键任务之后 | |
| 多任务有打卡检查 | |
| 超时留 30% 余量 | |
| 长耗时操作分段喂 | |
| 低功耗休眠 < 超时 | |
| 调试时冻结看门狗 | |
| 复位原因有记录 | |
| 现场可读复位计数 | |

### 0x69 可靠性测试

- **高低温**：-40 ~ 85 °C，LSI 频率会漂，超时时间跟着变；
- **电压拉偏**：3.0 ~ 3.6 V，看复位阈值；
- **EMC**：静电/群脉冲，看是否误触发复位；
- **长时间运行**：72 小时连续跑，统计复位次数；
- **掉电反复**：快速上下电，看是否能正常启动。

测试时把复位次数写进 BKP，跑完读出来，比盯屏幕可靠。

### 0x68 看门狗与电源/复位

- 电源跌落可能被误判为看门狗复位：读 `RCC_CSR` 区分 POR/IWDG；
- 复位不彻底（外部电容太大）会导致“复位后外设没初始化”；
- 外部看门狗芯片的复位脉冲宽度要满足 MCU 要求（通常 ≥20 µs）；
- 看门狗复位后 GPIO 回到默认状态，电机/继电器要默认关闭。

### 0x69 看门狗与 Flash 保存

保存参数/日志时擦写 Flash 很慢，处理不好会触发看门狗：

- 按页擦、每页喂狗；
- 或先关中断、延长超时（不推荐）；
- 或把保存放到“低优先级后台任务”，主循环继续喂狗。

```c
for (uint16_t page = 0; page < 4; page++)
{
    FLASH_ErasePage(ADDR + page * 1024);
    IWDG_Feed();
}
```

## 0x70 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| 上电就复位 | 没喂狗/超时太短 | 初始化后立刻喂，加长超时 |
| 偶尔复位 | 喂狗周期接近超时 | 留 30% 余量 |
| WWDG 一开就复位 | 初值/窗口不对，喂太早 | 按公式设窗口，等计数器降下来 |
| 调试时一直复位 | 调试器暂停，看门狗还在跑 | DBGMCU 冻结 |
| 喂狗了还复位 | 喂狗位置在死循环外/任务没跑到 | 任务打卡 + 监控 |
| IWDG 关不掉 | 启动后只能复位 | 调试阶段先不启动 |
| Stop 后复位 | 休眠超过超时 | 缩短休眠/唤醒喂狗 |
| 复位后不知道原因 | 没读 RCC_CSR | 上电打印复位标志 |
| 窗口看门狗计数不对 | PCLK1 频率/预分频算错 | 按 36 MHz 重算 |
| EWI 不进 | 没开 WWDG 中断/NVIC | `WWDG_EnableIT` + NVIC |
| 看门狗复位后外设异常 | 复位不彻底/初始化顺序 | 检查 `RCC_DeInit`/外设重配 |
| 低功耗电流大 | 看门狗/调试器 | 测电流时断开调试器 |

### 0x71 两个现场案例

**案例 1：中断风暴导致复位**

- 现象：通信量大时复位，日志 IWDG；
- 排查：串口中断优先级过高，连续收包把主循环饿死；
- 结论：中断里只入环形缓冲，主循环解析；喂狗任务优先级提高。

**案例 2：Flash 擦除导致复位**

- 现象：保存参数时偶尔复位；
- 排查：连续擦 10 页超过 1 s 超时；
- 结论：每页擦完喂一次，或延长超时。

### 0x72 看门狗选型

| 方案 | 优点 | 缺点 | 适用 |
| ---- | ---- | ---- | ---- |
| IWDG | 独立时钟、简单 | 不能关、精度低 | 通用 |
| WWDG | 窗口、精度高 | 依赖 PCLK1 | 硬实时 |
| 外部芯片 | 最可靠、可关 | 多一颗料 | 高可靠/长休眠 |
| 无看门狗 | 简单 | 卡死不自恢复 | 实验/一次性 |

## 0x80 小结

| 要点 | 说明 |
| ---- | ---- |
| 本质 | 不喂就复位的递减计数器 |
| IWDG | LSI、12 位、键寄存器 0x5555/0xAAAA/0xCCCC |
| WWDG | PCLK1、7 位、窗口内才能喂 |
| 喂狗位置 | 关键任务之后，不要中断里无脑喂 |
| 多任务 | 任务打卡 + 监控任务统一喂 |
| 调试 | DBGMCU 冻结 |
| 复位排查 | RCC_CSR 标志 + BKP 计数 |

### 思考题

1. IWDG 和 WWDG 的时钟源为什么不同？各自优缺点是什么？
2. 为什么 IWDG 启动后不能关闭？
3. 窗口看门狗的“窗口”能抓住什么类型的 bug？
4. 多任务系统里，为什么不能在主循环里直接喂狗？
5. 低功耗设备怎么处理 IWDG 的超时？

看门狗不是“加了就安全”，喂狗的位置才是设计核心：**喂在任务完成之后，才能证明任务真的活着**。
