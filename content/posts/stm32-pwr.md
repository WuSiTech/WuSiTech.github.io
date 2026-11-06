+++
title = "STM32 PWR：电源域、复位、PVD、低功耗与主频修改"
date = "2026-11-05T21:00:00+08:00"
lastmod = "2026-11-06T23:59:00+08:00"
draft = false
description = "从 VDD/VDDA/VBAT 三个电源域讲到复位源、PVD 电压监测，再吃透 Sleep/Stop/Standby 的进入、唤醒、时钟与电流，给出 PVD、三种低功耗、HSE+PLL 改主频、RTC 唤醒的完整 .h/.c/main.c 与 12 条故障排查。"
categories = [ "STM32" ]
tags = [ "STM32", "PWR", "低功耗" ]
cover = "/images/pool/covers/covers-16.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 13 章（13-1、13-2）。

代码基于 **STM32F103C8T6 + 标准外设库 3.5.0**，不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 13-1 | PWR 简介、电源框图、复位、电压调节器、PVD、低功耗模式、电流 | 0x00 ~ 0x40 |
| 13-2 | 修改主频、睡眠/停止/待机模式（代码、唤醒） | 0x50 ~ 0x70 |

视频之外还补了：电源去耦与布局、RCC_CSR 复位标志、PVD 中断、RTC/WKUP 唤醒、GPIO 漏电、电流测量、电池寿命、12 条故障排查。

## 0x00 PWR 管什么

PWR（Power Control）负责三件事：

- **电源监测**：PVD 监测 VDD，电压低于/高于阈值时触发中断，做紧急保存；
- **低功耗模式**：Sleep、Stop、Standby，空闲时把电流从几十 mA 降到 µA 级；
- **备份域供电**：VDD 掉电后由 VBAT 维持 RTC/BKP。

对电池设备来说，低功耗不是“可选项”，而是能不能活过一周的关键。

## 0x10 电源域

![STM32 电源框图](/images/posts/stm32-pwr/pwr-block.webp)

F103 的电源域分三块：

| 电源 | 范围 | 供给 |
| ---- | ---- | ---- |
| VDD / VSS | 2.0 ~ 3.6 V | IO、电压调节器、备份域 |
| VDDA / VSSA | 2.0 ~ 3.6 V | ADC、温度传感器、复位、PLL |
| VBAT | 1.8 ~ 3.6 V | LSE、RTC、BKP、PC13~PC15 |

内部还有：

- **电压调节器**：把 VDD 降到 1.8 V 给内核、SRAM、数字外设；
- **低电压检测器**：监视 1.8 V 域；
- **备份域**：VDD 掉电后自动切到 VBAT。

### 0x11 上电顺序

- VDDA 和 VDD 要一起上电，且 VDDA 不能高于 VDD；
- 否则可能通过内部二极管倒灌，导致复位异常/发热；
- 推荐 VDD 和 VDDA 由同一路 3.3 V 供电，VDDA 串磁珠/电感 + 电容滤波。

### 0x12 去耦与布局

- 每个 VDD 引脚旁放 100 nF，尽量靠近引脚；
- 板级再放 10 µF 钽电容/陶瓷电容；
- VDDA 用 10 µH 磁珠 + 100 nF + 1 µF；
- 晶振、复位、BOOT0 走线远离电源/电机；
- 地平面完整，模拟地和数字地单点连接。

### 0x13 电源电流估算

| 场景 | 电流（3.3 V） |
| ---- | ------------- |
| 72 MHz 全速 | 30 ~ 50 mA |
| 8 MHz | 5 ~ 10 mA |
| Sleep | 1 ~ 5 mA |
| Stop | 10 ~ 20 µA |
| Standby | 约 2 µA |

电池寿命：

```text
寿命 = 电池容量 / 平均电流
```

CR2032 220 mAh、平均 20 µA：

```text
220 mAh / 0.02 mA ≈ 11000 小时 ≈ 1.25 年
```

所以低功耗设备要尽量把“醒着的时间”压短。

### 0x14 供电方案

常见三种：

| 方案 | 说明 | 适用 |
| ---- | ---- | ---- |
| USB 5 V → LDO 3.3 V | 简单、便宜 | 开发板、低功耗小设备 |
| 电池 → DC-DC → 3.3 V | 效率高 | 电池产品 |
| 12 V → DC-DC → 5 V → LDO 3.3 V | 工业/车载 | 宽压输入 |

LDO 选型看：

- 压差（dropout）：3.3 V 输出时输入至少 3.5 V；
- 静态电流：电池设备选 µA 级（如 HT7333、XC6206）；
- 最大电流：留 2 倍余量；
- PSRR：ADC 供电要求高时选高 PSRR。

### 0x15 电源保护

- 输入端加 TVS（SMAJ5.0A）防浪涌；
- 反接保护：MOS 管/二极管；
- 过流：自恢复保险丝/PTC；
- 热插拔：缓启动电路；
- 电池供电：低压检测 + 自动关机。

### 0x16 上电时序与 BOR

上电时 VDD 从 0 升到 3.3 V，如果上升太慢或抖动，可能触发多次复位。F103 内部有 POR/PDR（约 1.8 V 阈值），但没有可调的 BOR（欠压复位）等级。

要求高的场合：

- 外部加电压监控芯片（如 MAX809），低于阈值拉低 NRST；
- 电源上升时间控制在几十 ms 内；
- 大电容负载要加缓启动。

### 0x17 电源与 ADC 的关系

ADC 的参考就是 VDDA，电源噪声会直接进采样结果：

- VDDA 单独滤波（磁珠 + 10 µF + 100 nF）；
- 不要和电机/继电器共用一路；
- ADC 采样时避开 PWM 开关瞬间（可用定时器触发同步）。

## 0x20 复位

F103 的复位源：

| 复位源 | 标志（RCC_CSR） | 说明 |
| ------ | ---------------- | ---- |
| POR/PDR | PORRSTF/PINRSTF | 上电/掉电复位 |
| NRST | PINRSTF | 外部复位引脚 |
| 软件复位 | SFTRSTF | `NVIC_SystemReset()` |
| IWDG | IWDGRSTF | 独立看门狗 |
| WWDG | WWDGRSTF | 窗口看门狗 |
| 低功耗 | LPWRRSTF | Standby 唤醒 |

上电后可以读标志判断“上次为什么复位”：

```c
if (RCC_GetFlagStatus(RCC_FLAG_IWDGRST) == SET)
{
    /* 看门狗复位 */
}
RCC_ClearFlag();   /* 清标志 */
```

调试时如果程序“跑飞”，先看这几个标志，能快速区分“上电/看门狗/软件复位”。

### 0x21 复位电路

NRST 是低电平复位，典型电路：

```text
VDD ── 10kΩ ── NRST ── 100nF ── GND
                 │
                 └── 按键 ── GND
```

- 上电时电容充电，NRST 保持低电平一段时间，保证复位；
- 按键按下手动复位；
- 电容太大复位变慢，太小抗干扰差，100 nF 是常用值；
- NRST 内部有上拉，外部 10k 是冗余/加强。

### 0x22 复位标志诊断

```c
void Reset_Print(void)
{
    if (RCC_GetFlagStatus(RCC_FLAG_PORRST) == SET)  printf("POR/PDR\r\n");
    if (RCC_GetFlagStatus(RCC_FLAG_PINRST) == SET)  printf("NRST\r\n");
    if (RCC_GetFlagStatus(RCC_FLAG_SFTRST) == SET)  printf("Software\r\n");
    if (RCC_GetFlagStatus(RCC_FLAG_IWDGRST) == SET) printf("IWDG\r\n");
    if (RCC_GetFlagStatus(RCC_FLAG_WWDGRST) == SET) printf("WWDG\r\n");
    if (RCC_GetFlagStatus(RCC_FLAG_LPWRRST) == SET) printf("LowPower\r\n");

    RCC_ClearFlag();
}
```

上电先打印复位原因，能快速区分“正常上电/看门狗/电源跌落”。

## 0x30 PVD 电压监测

PVD 监测 VDD，阈值可选 2.2 ~ 2.9 V：

```c
void PVD_Init(void)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_PWR, ENABLE);

    PWR_PVDLevelConfig(PWR_PVDLevel_2V9);
    PWR_PVDCmd(ENABLE);

    /* PVD 事件接到 EXTI16 */
    EXTI_InitTypeDef EXTI_InitStructure;
    EXTI_InitStructure.EXTI_Line = EXTI_Line16;
    EXTI_InitStructure.EXTI_Mode = EXTI_Mode_Interrupt;
    EXTI_InitStructure.EXTI_Trigger = EXTI_Trigger_Falling;
    EXTI_InitStructure.EXTI_LineCmd = ENABLE;
    EXTI_Init(&EXTI_InitStructure);

    NVIC_InitTypeDef NVIC_InitStructure;
    NVIC_InitStructure.NVIC_IRQChannel = PVD_IRQn;
    NVIC_InitStructure.NVIC_IRQChannelCmd = ENABLE;
    NVIC_InitStructure.NVIC_IRQChannelPreemptionPriority = 0;
    NVIC_InitStructure.NVIC_IRQChannelSubPriority = 0;
    NVIC_Init(&NVIC_InitStructure);
}

void PVD_IRQHandler(void)
{
    if (EXTI_GetITStatus(EXTI_Line16) == SET)
    {
        /* 电压跌落：保存关键数据到 BKP/Flash */
        EXTI_ClearITPendingBit(EXTI_Line16);
    }
}
```

### 0x31 电压跌落时保存什么

PVD 中断里时间很短（可能只有几 ms），只做最要紧的事：

```c
volatile uint32_t RunState;

void PVD_IRQHandler(void)
{
    if (EXTI_GetITStatus(EXTI_Line16) == SET)
    {
        /* 1. 写掉电标志 */
        BKP_WriteBackupRegister(BKP_DR9, 0xDEAD);

        /* 2. 保存运行状态（16 位一组） */
        BKP_WriteBackupRegister(BKP_DR10, RunState & 0xFFFF);

        /* 3. 关外设，降低电流，争取时间 */
        GPIO_SetBits(GPIOA, GPIO_Pin_5);   /* 关电机等大负载 */

        EXTI_ClearITPendingBit(EXTI_Line16);
    }
}
```

保存到 BKP（寄存器写，纳秒级）比写 Flash（ms 级）可靠得多；Flash 写入需要电压稳定，掉电时写 Flash 反而可能写坏。

### 0x32 阈值怎么选

3.3 V 系统、LDO 压差 0.3 V、后级电容 100 µF、负载 50 mA：

```text
掉电后维持时间 ≈ C × ΔV / I = 100µF × 0.4V / 50mA ≈ 0.8 ms
```

PVD 阈值选 2.9 V，留 0.4 V 余量；电容太小/负载太大时，可能来不及保存，要加电容或提前检测（比如监测前级 5 V）。

### 0x33 PVD 与 ADC 联动

PVD 只能判断“高于/低于阈值”，要知道具体电压还得靠 ADC。可以：

- PVD 触发后，立刻用 ADC 采一次电池分压，记录跌落值；
- 用 VREFINT 反推 VDDA，判断是电池掉还是 LDO 掉；
- 把“掉电时电压”写进 BKP，售后能看出是电池耗尽还是电源故障。

### 0x34 PVD 阈值与迟滞

可选阈值：

| 等级 | 阈值 |
| ---- | ---- |
| 0 | 2.2 V |
| 1 | 2.3 V |
| 2 | 2.4 V |
| 3 | 2.5 V |
| 4 | 2.6 V |
| 5 | 2.7 V |
| 6 | 2.8 V |
| 7 | 2.9 V |

PVD 有一定迟滞，电压在阈值附近抖动时不会反复中断。选阈值要留出 LDO 压差和保存时间的余量。

## 0x40 低功耗模式

![低功耗模式一览](/images/posts/stm32-pwr/lowpower-table.webp)

| 模式 | 进入 | 唤醒 | 1.8 V 域时钟 | 电压调节器 | 典型电流 |
| ---- | ---- | ---- | ------------ | ---------- | -------- |
| Sleep | WFI/WFE | 任意中断/事件 | CPU 停，外设照跑 | 开 | mA 级 |
| Stop | PDDS + LPDS + WFI/WFE | 任一 EXTI 中断 | 全关 | 低功耗 | 十几 µA |
| Standby | PDDS + LPDS + WFI/WFE | WKUP 上升沿、RTC、NRST、IWDG | 全关 | 关 | 约 2 µA |

### 0x41 睡眠模式

![睡眠模式](/images/posts/stm32-pwr/sleep-mode.webp)

执行 `WFI`/`WFE` 后 CPU 停止，外设（定时器、串口、ADC）继续跑；任意中断都能唤醒，唤醒后从暂停处继续执行。

```c
void Enter_Sleep(void)
{
    __WFI();   /* 进入睡眠，等中断唤醒 */
}
```

- `SLEEPONEXIT` 决定“执行完 WFI 立刻睡”还是“等退出最低优先级中断再睡”；
- 适合“等一个中断”的场合，比如等串口收完一帧；
- 唤醒延迟最短。

### 0x42 停止模式

```c
void Enter_Stop(void)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_PWR, ENABLE);

    PWR_EnterSTOPMode(PWR_Regulator_LowPower, PWR_STOPEntry_WFI);

    /* 唤醒后时钟默认 HSI 8MHz，必须重配 */
    SystemInit();
    /* 重新初始化用到的外设：串口、定时器、ADC... */
}
```

特点：

- 关掉 1.8 V 域所有时钟（PLL、HSI、HSE 全停），SRAM 和寄存器内容保留；
- 电压调节器进入低功耗；
- 任一 EXTI 中断唤醒；
- 唤醒后系统时钟默认切回 **HSI 8 MHz**，必须重新配置时钟，否则串口波特率、定时器全乱。

### 0x43 待机模式

```c
void Enter_Standby(void)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_PWR, ENABLE);

    PWR_WakeUpPinCmd(ENABLE);   /* 使能 WKUP 引脚 */
    PWR_EnterSTANDBYMode();     /* 进入待机，唤醒后复位 */
}
```

- 1.8 V 域完全断电，只有备份域和 WKUP 引脚活着；
- 唤醒源：WKUP 引脚上升沿、RTC 闹钟/唤醒、NRST、IWDG；
- 唤醒后相当于**复位**：程序从头跑，SRAM 内容丢失；
- 电流最低（约 2 µA）。

进 Standby 前要把重要状态写进 BKP 或 Flash，否则唤醒后什么都没有了。唤醒后可以读 `PWR_GetFlagStatus(PWR_FLAG_WU)` 判断是不是 WKUP 唤醒。

### 0x44 RTC 闹钟唤醒

```c
void Enter_Standby_Until(uint32_t WakeStamp)
{
    RTC_SetAlarm(WakeStamp);
    RTC_WaitForLastTask();
    RTC_ITConfig(RTC_IT_ALR, ENABLE);
    RTC_WaitForLastTask();

    PWR_EnterSTANDBYMode();
}
```

RTC 在备份域里走，Stop/Standby 都能用闹钟唤醒；Standby 唤醒后是复位，Stop 唤醒后继续执行。

### 0x45 唤醒源对比

| 模式 | 可用唤醒源 |
| ---- | ---------- |
| Sleep | 任意中断/事件 |
| Stop | EXTI（任意外部中断线） |
| Standby | WKUP 引脚、RTC、NRST、IWDG |

### 0x46 Stop 完整工程

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "Serial.h"
#include "PWR.h"

void EXTI0_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_0;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    GPIO_EXTILineConfig(GPIO_PortSourceGPIOA, GPIO_PinSource0);

    EXTI_InitTypeDef EXTI_InitStructure;
    EXTI_InitStructure.EXTI_Line = EXTI_Line0;
    EXTI_InitStructure.EXTI_Mode = EXTI_Mode_Interrupt;
    EXTI_InitStructure.EXTI_Trigger = EXTI_Trigger_Falling;
    EXTI_InitStructure.EXTI_LineCmd = ENABLE;
    EXTI_Init(&EXTI_InitStructure);

    NVIC_InitTypeDef NVIC_InitStructure;
    NVIC_InitStructure.NVIC_IRQChannel = EXTI0_IRQn;
    NVIC_InitStructure.NVIC_IRQChannelCmd = ENABLE;
    NVIC_InitStructure.NVIC_IRQChannelPreemptionPriority = 1;
    NVIC_InitStructure.NVIC_IRQChannelSubPriority = 1;
    NVIC_Init(&NVIC_InitStructure);
}

void Enter_Stop_EXTI(void)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_PWR, ENABLE);

    Serial_SendString("Enter STOP\r\n");
    Delay_ms(10);

    PWR_EnterSTOPMode(PWR_Regulator_LowPower, PWR_STOPEntry_WFI);

    /* 唤醒后：HSI 8MHz，重配时钟和外设 */
    SystemInit();
    Serial_Init();
    Serial_SendString("Wake up\r\n");
}

void EXTI0_IRQHandler(void)
{
    if (EXTI_GetITStatus(EXTI_Line0) == SET)
    {
        EXTI_ClearITPendingBit(EXTI_Line0);
    }
}
```

现象：按键前串口输出 `Enter STOP`，按键后输出 `Wake up`。如果唤醒后没输出，多半是没重配串口/时钟。

### 0x47 Standby 完整工程

```c
void Enter_Standby_WithState(uint32_t State)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_PWR, ENABLE);
    PWR_BackupAccessCmd(ENABLE);

    /* 保存状态到 BKP */
    BKP_WriteBackupRegister(BKP_DR8, 0x55AA);
    BKP_WriteBackupRegister(BKP_DR9, State & 0xFFFF);

    /* 使能 WKUP 引脚（PA0） */
    PWR_WakeUpPinCmd(ENABLE);

    PWR_EnterSTANDBYMode();
}

/* 上电/唤醒后判断 */
void Standby_Check(void)
{
    if (PWR_GetFlagStatus(PWR_FLAG_WU) == SET)
    {
        /* 是 WKUP 唤醒 */
        PWR_ClearFlag(PWR_FLAG_WU);
    }

    if (BKP_ReadBackupRegister(BKP_DR8) == 0x55AA)
    {
        uint32_t State = BKP_ReadBackupRegister(BKP_DR9);
        BKP_WriteBackupRegister(BKP_DR8, 0x0000);
        /* 恢复 State */
    }
}
```

注意：Standby 唤醒后程序从头跑，`main` 里要先调用 `Standby_Check()` 再初始化外设。

### 0x48 WFI 与 WFE

- **WFI**（Wait For Interrupt）：等中断，任何使能的中断都能唤醒；
- **WFE**（Wait For Event）：等事件，`SEVONPEND`/事件寄存器可唤醒，适合“中断关了但想被事件唤醒”。

进入 Stop 一般用 WFI；如果关了全局中断又想让 EXTI 唤醒，需要配 `EXTI_InitStructure.EXTI_LineCmd` 和 `__SEV()`/`__WFE()`。

### 0x49 Stop 模式下外设状态

| 外设 | Stop 下状态 |
| ---- | ----------- |
| 内核 | 停 |
| SRAM/寄存器 | 保持 |
| HSI/HSE/PLL | 停 |
| LSE/LSI | 可保持（RTC 用） |
| GPIO | 保持进入前状态 |
| 串口/SPI/I2C | 停，唤醒后重配 |
| ADC | 停 |
| RTC/BKP | 由 VBAT 供电，继续走 |
| 独立看门狗 | 继续计数（要喂） |

所以进 Stop 前要：

- 关不用的外设时钟；
- 把 GPIO 设成不耗电的状态；
- 确认看门狗不会在休眠期间复位（或先关掉）。

## 0x50 修改主频

### 0x51 时钟树

```text
HSE 8MHz ─┐
HSI 8MHz ─┼─ PLL ─ SYSCLK ─ AHB ─ HCLK ─ APB1 (≤36MHz)
          │                     └─ APB2 (≤72MHz)
```

- SYSCLK 最高 72 MHz；
- AHB 不分频；
- APB1 最高 36 MHz（定时器时钟 ×2）；
- APB2 最高 72 MHz；
- Flash 等待周期随主频增加。

### 0x52 Flash 等待周期

| 主频 | 等待周期 |
| ---- | -------- |
| ≤24 MHz | 0 |
| 24 ~ 48 MHz | 1 |
| 48 ~ 72 MHz | 2 |

```c
FLASH_SetLatency(FLASH_Latency_2);
FLASH_PrefetchBufferCmd(FLASH_PrefetchBuffer_Enable);
```

### 0x53 72 MHz 配置

```c
void Clock_Init72MHz(void)
{
    RCC_DeInit();

    RCC_HSEConfig(RCC_HSE_ON);
    while (RCC_GetFlagStatus(RCC_FLAG_HSERDY) == RESET);

    RCC_HCLKConfig(RCC_SYSCLK_Div1);
    RCC_PCLK1Config(RCC_HCLK_Div2);   /* 36MHz */
    RCC_PCLK2Config(RCC_HCLK_Div1);   /* 72MHz */

    FLASH_SetLatency(FLASH_Latency_2);
    FLASH_PrefetchBufferCmd(FLASH_PrefetchBuffer_Enable);

    RCC_PLLConfig(RCC_PLLSource_HSE_Div1, RCC_PLLMul_9);   /* 8×9=72 */
    RCC_PLLCmd(ENABLE);
    while (RCC_GetFlagStatus(RCC_FLAG_PLLRDY) == RESET);

    RCC_SYSCLKConfig(RCC_SYSCLKSource_PLLCLK);
    while (RCC_GetSYSCLKSource() != 0x08);

    SystemCoreClockUpdate();
}
```

### 0x54 48 MHz 配置

```c
RCC_PLLConfig(RCC_PLLSource_HSE_Div1, RCC_PLLMul_6);   /* 8×6=48 */
```

APB1 分频 2 → 24 MHz，APB2 不分频 → 48 MHz。Flash 等待周期 1。

### 0x55 修改主频后要同步改

- 串口波特率（库按 `SystemCoreClock` 算，但要在时钟稳定后初始化）；
- 定时器 PSC（72 MHz 下的分频值不再适用）；
- ADC 时钟（不能超过 14 MHz）；
- Flash 等待周期；
- `SystemCoreClockUpdate()`，否则 `Delay_ms`、`HAL` 时基全错。

### 0x56 运行时切换主频

运行中改主频，不能直接改 PLL，要先把 SYSCLK 切到 HSI：

```c
void Clock_Switch(uint32_t PLLMul)
{
    /* 1. 切到 HSI */
    RCC_SYSCLKConfig(RCC_SYSCLKSource_HSI);
    while (RCC_GetSYSCLKSource() != 0x00);

    /* 2. 关 PLL */
    RCC_PLLCmd(DISABLE);
    while (RCC_GetFlagStatus(RCC_FLAG_PLLRDY) == SET);

    /* 3. 重配 PLL */
    RCC_PLLConfig(RCC_PLLSource_HSE_Div1, PLLMul);
    RCC_PLLCmd(ENABLE);
    while (RCC_GetFlagStatus(RCC_FLAG_PLLRDY) == RESET);

    /* 4. 配 Flash 等待周期（按目标频率） */
    if (PLLMul <= RCC_PLLMul_3)       FLASH_SetLatency(FLASH_Latency_0);
    else if (PLLMul <= RCC_PLLMul_6)  FLASH_SetLatency(FLASH_Latency_1);
    else                              FLASH_SetLatency(FLASH_Latency_2);

    /* 5. 切回 PLL */
    RCC_SYSCLKConfig(RCC_SYSCLKSource_PLLCLK);
    while (RCC_GetSYSCLKSource() != 0x08);

    SystemCoreClockUpdate();
}
```

切频期间外设时钟会变，串口/定时器要重新初始化；不要在中断里切频。

### 0x57 用 MCO 验证主频

PA8 可以输出 SYSCLK/PLL/HSI/HSE 的分频：

```c
RCC_MCOConfig(RCC_MCO_SYSCLK_Div4);   /* PA8 输出 SYSCLK/4 */
```

72 MHz 时 PA8 输出 18 MHz，示波器一量就知道 PLL 有没有生效。测完记得关掉 MCO（`RCC_MCOConfig(RCC_MCO_NoClock)`），省电。

### 0x58 PLL 起振失败

HSE 坏了/没焊，程序会卡在 `while (RCC_GetFlagStatus(RCC_FLAG_HSERDY) == RESET)`。工程写法：

```c
uint32_t Timeout = 100000;
RCC_HSEConfig(RCC_HSE_ON);

while (RCC_GetFlagStatus(RCC_FLAG_HSERDY) == RESET)
{
    if (--Timeout == 0)
    {
        RCC_HSEConfig(RCC_HSE_OFF);
        /* 退回 HSI，限制功能，至少能跑 */
        break;
    }
}
```

产品里最好把“时钟源状态”写进 BKP/日志，方便售后判断。

### 0x59 时钟安全系统 CSS

HSE 突然停振（晶振坏、虚焊）时，CPU 可能跑飞。CSS 会自动切到 HSI 并产生 NMI：

```c
RCC_ClockSecuritySystemCmd(ENABLE);
```

```c
void NMI_Handler(void)
{
    if (RCC_GetITStatus(RCC_IT_CSS) == SET)
    {
        RCC_ClearITPendingBit(RCC_IT_CSS);
        /* 切到 HSI，记录故障，降级运行 */
    }
}
```

开了 CSS 之后，HSE 故障不会死机，但主频会掉到 8 MHz，串口/定时器参数要相应调整。

## 0x60 低功耗设计

### 0x61 GPIO 漏电

- 悬空输入会因浮空而反复翻转，增加功耗；
- 不用的引脚配成**模拟输入**（`GPIO_Mode_AIN`）或下拉；
- 输出引脚不要接 LED/上拉，除非需要；
- 外部模块不用的电源要能断开。

### 0x62 外设时钟

```c
RCC_APB2PeriphClockCmd(RCC_APB2Periph_ADC1, DISABLE);
RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM2, DISABLE);
```

不用的外设全部关时钟；睡眠前把外设配成低功耗状态。

### 0x63 电池寿命优化

```text
平均电流 = (活跃电流 × 活跃时间 + 休眠电流 × 休眠时间) / 周期
```

例：每 10 秒醒 50 ms、活跃 30 mA、休眠 5 µA：

```text
平均 ≈ (30mA × 0.05s + 0.005mA × 9.95s) / 10s ≈ 0.155 mA
```

比一直 30 mA 省了 200 倍。

### 0x64 电流测量

- 把板子的电源跳线帽拔掉，万用表串进去测；
- 测 µA 级要用 µA 档，且注意万用表内阻；
- 用 0.1 Ω 采样电阻 + 示波器看动态电流；
- 测之前确认所有外设/调试器都断开（SWD 也会耗电）。

### 0x65 RTC 周期唤醒

“每 10 秒醒一次采样”的低功耗模型：

```c
void RTC_Wakeup_Init(uint32_t Seconds)
{
    RTC_SetAlarm(RTC_GetCounter() + Seconds);
    RTC_WaitForLastTask();

    RTC_ITConfig(RTC_IT_ALR, ENABLE);
    RTC_WaitForLastTask();

    /* 闹钟中断走 EXTI17 */
    EXTI_InitTypeDef EXTI_InitStructure;
    EXTI_InitStructure.EXTI_Line = EXTI_Line17;
    EXTI_InitStructure.EXTI_Mode = EXTI_Mode_Interrupt;
    EXTI_InitStructure.EXTI_Trigger = EXTI_Trigger_Rising;
    EXTI_InitStructure.EXTI_LineCmd = ENABLE;
    EXTI_Init(&EXTI_InitStructure);

    NVIC_InitTypeDef NVIC_InitStructure;
    NVIC_InitStructure.NVIC_IRQChannel = RTCAlarm_IRQn;
    NVIC_InitStructure.NVIC_IRQChannelCmd = ENABLE;
    NVIC_InitStructure.NVIC_IRQChannelPreemptionPriority = 1;
    NVIC_InitStructure.NVIC_IRQChannelSubPriority = 1;
    NVIC_Init(&NVIC_InitStructure);
}
```

醒来后：

1. 读传感器；
2. 需要的话通过串口/无线发出去；
3. 重新设下一个闹钟；
4. 再进 Stop。

这样平均电流可以压到几十 µA。

### 0x66 低功耗 GPIO 清单

| 引脚状态 | 处理 |
| -------- | ---- |
| 未使用 | 配模拟输入（`GPIO_Mode_AIN`） |
| 输入悬空 | 上拉/下拉，别浮空 |
| 输出高接 LED | 改成低电平熄灭 |
| 输出接外部上拉 | 改成开漏/模拟 |
| 调试口 SWD | 保留，调试器会耗电 |
| 晶振引脚 | 用不到时关 HSE/LSE |

### 0x67 实战：电池供电的无线传感器节点

典型流程：

1. 上电初始化，读 BKP 判断是否首次；
2. 每 60 秒 RTC 闹钟唤醒；
3. 读传感器（I2C/ADC）；
4. 通过 LoRa/NRF 发一包数据；
5. 记一次 BKP 计数；
6. 进 Stop（或 Standby）。

平均电流估算：

```text
活跃 200ms × 25mA + 休眠 59.8s × 15µA
平均 ≈ (5mA·s + 0.897mA·s) / 60s ≈ 0.098mA
```

两节 AA（2000 mAh）可用约 2 年。想更久：

- 缩短活跃时间（DMA、提高 SPI 时钟）；
- 降低发射功率/缩短发射时间；
- 用 Standby + RTC 唤醒；
- 选低静态电流的 LDO。

## 0x70 实验与调试

### 0x71 电流对比

| 模式 | 实测（参考） |
| ---- | ------------ |
| 72 MHz 全速 | 30 ~ 50 mA |
| Sleep | 5 ~ 10 mA |
| Stop | 10 ~ 20 µA |
| Standby | 1 ~ 3 µA |

实测比手册大很多，先查：调试器、LED、外部模块、悬空引脚、稳压器静态电流。

### 0x72 唤醒实验

- Sleep：按按键进中断，程序继续；
- Stop：RTC 闹钟/EXTI 唤醒，注意唤醒后重配时钟；
- Standby：WKUP 按键唤醒，程序从头跑。

### 0x73 主频验证

```c
SystemCoreClockUpdate();
printf("SYSCLK=%lu\r\n", SystemCoreClock);
```

再用 MCO 引脚输出 SYSCLK/4，示波器量频率，确认 PLL 真的生效。

### 0x74 功耗测量方法

**万用表法**：

1. 拔掉板子的电源跳线；
2. 万用表打到 µA/mA 档，串在电源和板子之间；
3. 不同模式分别读数。

注意：万用表内阻会影响低压差场景；测 Standby 时表笔接触要稳。

**采样电阻法**：

```text
电源 ── 0.1Ω ── 板子
         │
       示波器差分探头
```

0.1 Ω 上 1 mA 产生 100 µV，需要高灵敏度探头/放大器；优点是不中断供电，能看动态电流。

**专用功耗分析仪**（Nordic PPK2、Joulescope）能画 µA 到 mA 的实时曲线，调试低功耗最直观。

### 0x75 电流波形分析

- 周期性尖峰：定时器/无线发射；
- 持续 mA 级：外设没关/GPIO 漏电；
- 唤醒后电流不降：忘了重新进低功耗；
- Standby 还有几百 µA：外部模块/调试器/稳压器静态电流。

### 0x76 测唤醒时间

用 GPIO 在进入低功耗前拉高、唤醒后拉低，示波器量高电平宽度：

```c
GPIO_SetBits(GPIOA, GPIO_Pin_5);
PWR_EnterSTOPMode(PWR_Regulator_LowPower, PWR_STOPEntry_WFI);
GPIO_ResetBits(GPIOA, GPIO_Pin_5);
```

- Sleep 唤醒：几个 µs；
- Stop 唤醒：几十 µs（含 HSI 起振、时钟重配）；
- Standby 唤醒：相当于复位，几 ms。

唤醒时间决定“醒着多久”，直接影响平均功耗。

### 0x77 功耗预算表

| 器件 | 工作电流 | 休眠电流 | 占比 |
| ---- | -------- | -------- | ---- |
| MCU | 25 mA | 5 µA | 主要 |
| 传感器 | 1 mA | 1 µA | 中 |
| 无线模块 | 120 mA（发射） | 1 µA | 峰值 |
| LDO | — | 5 µA | 长期 |
| LED | 5 mA | 0 | 可关 |

先列预算，再算平均电流；只看“待机电流”容易忽略“发射瞬间”的大电流和 LDO 的静态电流。

## 0x80 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| Stop 唤醒后串口乱码 | 时钟变回 HSI 没重配 | `SystemInit()` 后重初始化 |
| Standby 唤醒变量全丢 | Standby 等同复位 | 关键数据存 BKP/Flash |
| 进不了低功耗 | 调试器连着、中断一直触发 | 断开 SWD、查中断源 |
| 电流降不下来 | GPIO 悬空、外设时钟没关 | 配模拟输入、关时钟 |
| PVD 中断不进 | 没配 EXTI16/NVIC | 配 EXTI + NVIC |
| 改主频后延时不准 | `SystemCoreClock` 没更新 | `SystemCoreClockUpdate()` |
| 72 MHz 跑飞 | Flash 等待周期不够 | 设 2 个等待周期 |
| APB1 超 36 MHz | 分频配错 | `RCC_PCLK1Config(Div2)` |
| 唤醒后外设不工作 | 没重新初始化 | 重配串口/定时器/ADC |
| 待机电流仍大 | 外部模块漏电 | 断电/加 MOS 开关 |
| NRST 一直低 | 外部复位电路/电容 | 查复位引脚 |
| 电池很快没电 | 平均电流估算错 | 测实际电流、缩短唤醒时间 |

## 0x90 小结

| 模式 | 唤醒后 | 数据 | 电流 | 适用 |
| ---- | ------ | ---- | ---- | ---- |
| Sleep | 继续执行 | 保留 | mA | 等中断 |
| Stop | 继续执行（时钟需重配） | 保留 | µA | 短时休眠 |
| Standby | 复位重跑 | 丢失 | ~2 µA | 长期待机 |

### 0x91 低功耗检查表

| 检查项 | 处理 |
| ------ | ---- |
| 未使用 GPIO | 配模拟输入/下拉 |
| 外设时钟 | 不用的全部关闭 |
| 调试器 | 测电流时拔掉 SWD |
| LED/上拉 | 不需要的去掉或改低电平 |
| 稳压器 | 选低静态电流型号 |
| 外部模块 | 不用的断电（MOS 开关） |
| 唤醒周期 | 尽量长、活跃时间尽量短 |
| 看门狗 | 休眠期间是否需要继续喂 |
| 电池 | 电压/内阻/自放电 |
| 时钟 | 用 LSE 时关 HSE |

逐项打勾，基本能把“莫名几百 µA”找出来。

### 思考题

1. 为什么 Stop 唤醒后必须重新配置时钟？
2. Standby 和复位有什么区别？
3. PVD 能阻止掉电吗？它的正确用法是什么？
4. 修改主频后，哪些外设参数需要跟着改？
5. 为什么“悬空引脚”会增加功耗？

低功耗的套路是：**能睡就睡、能关的时钟全关、GPIO 配成模拟/下拉、唤醒后先重配时钟再干活**。
