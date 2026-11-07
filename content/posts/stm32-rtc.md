+++
title = "STM32 RTC 与 BKP：Unix 时间戳、备份域与掉电走时"
date = "2026-11-05T19:30:00+08:00"
lastmod = "2026-11-06T23:59:00+08:00"
draft = false
description = "从 Unix 时间戳与 2038 问题讲起，吃透 BKP 备份寄存器、VBAT 供电、RTC 的 LSE/LSI/HSE 时钟源、预分频与影子寄存器，给出首次初始化/掉电保持、时间戳与日期互转、秒中断、闹钟、OLED 时钟的完整 .h/.c/main.c 与 12 条故障排查。"
categories = [ "STM32" ]
tags = [ "STM32", "RTC", "BKP", "时间戳" ]
cover = "/images/pool/covers/covers-15.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 12 章（12-1 ~ 12-3）。

代码基于 **STM32F103C8T6 + STM32F10x 标准外设库 3.5.0**（API 已按 STM32F10x StdPeriph 3.5 头文件核对；Delay/OLED/Key 为课程配套驱动），不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 12-1 | Unix 时间戳、时间换算、2038 问题 | 0x10 |
| 12-2 | BKP 简介、RTC 简介、时钟源、预分频、计数器、闹钟、框图、硬件电路 | 0x20 ~ 0x50 |
| 12-3 | 读写备份寄存器、RTC 初始化、设置/读取时间、显示 | 0x60 ~ 0x70 |

视频之外还补了：电池寿命计算、LSE 起振与负载电容、影子寄存器/同步、秒中断与闹钟、时间精度测量、12 条故障排查。

## 0x00 时间从哪来

单片机自己不会“知道”现在是几点。要做时钟，需要三样东西：

1. **一个稳定的时间基准**：32.768 kHz 晶振；
2. **一个不断累加的计数器**：RTC 的 32 位 CNT；
3. **掉电后继续供电**：VBAT + 纽扣电池。

STM32 的 RTC 就在**备份域**里：主电源 VDD 掉电后，VBAT 继续给 RTC 和 BKP 供电，时间不停、备份寄存器不丢。

## 0x10 Unix 时间戳

Unix 时间戳 = 从 **1970-01-01 00:00:00 UTC** 起经过的秒数，用一个 32 位无符号整数存。

```text
2026-11-06 23:00:00 UTC+8
= 2026-11-06 15:00:00 UTC
= 1793986800（示例值）
```

### 0x11 为什么用时间戳

- 一个整数就能表示时间，比较、相减、存储都方便；
- 跨时区、跨平台统一；
- RTC 的计数器天然就是时间戳，不需要“年月日时分秒”六个寄存器。

### 0x12 2038 问题

32 位**有符号**整数最大 2147483647，对应 **2038-01-19 03:14:07 UTC**，之后变负数。用 `uint32_t` 可以撑到 **2106-02-07**。

STM32 的 RTC_CNT 是 32 位无符号，所以到 2106 年才溢出；但很多老系统用 `time_t`（有符号 32 位），2038 年会出问题。

### 0x13 时区与闰年

- 时间戳永远是 UTC；显示本地时间要加时区偏移（中国 +8 小时 = 28800 秒）；
- 闰年规则：能被 4 整除且不能被 100 整除，或能被 400 整除；
- 每月天数：1/3/5/7/8/10/12 为 31 天，4/6/9/11 为 30 天，2 月平年 28、闰年 29。

### 0x14 时间戳与日期互转

时间戳 → 日期：

```text
days = stamp / 86400
rem  = stamp % 86400
hour = rem / 3600
min  = (rem % 3600) / 60
sec  = rem % 60
```

再从 `days` 逐年减 365/366，逐月减 28/29/30/31，剩下的就是“日”。

日期 → 时间戳是反过程：先算从 1970 到目标年的天数，再加月、日、时分秒。

### 0x15 边界测试

时间换算最容易在“闰年 2 月 29 日”“12 月 31 日 23:59:59”“2038 跨年”出错。写个自测：

```c
void RTC_Test(void)
{
    uint32_t cases[] = {
        0,            /* 1970-01-01 00:00:00 */
        951782400,    /* 2000-02-29 00:00:00 */
        4102444799,   /* 2099-12-31 23:59:59 */
        4294967295,   /* 2106-02-07 06:28:15 */
    };

    for (uint8_t i = 0; i < 4; i++)
    {
        uint16_t y; uint8_t mo, d, h, mi, s;
        MyRTC_StampToTime(cases[i], &y, &mo, &d, &h, &mi, &s);
        printf("%u -> %04d-%02d-%02d %02d:%02d:%02d\r\n", cases[i], y, mo, d, h, mi, s);
    }
}
```

把结果和在线时间戳工具对比，能提前发现闰年/月份边界 bug。

### 0x16 时间戳在工程里的用法

- **日志**：每条记录带时间戳，排序、查问题都方便；
- **定时任务**：比较“当前时间 - 上次时间”；
- **数据存储**：一个 `uint32_t` 代替六个字段；
- **通信**：上位机/服务器统一用时间戳，避免时区歧义。

注意：时间戳没有时区信息，显示时才转本地时间；跨时区设备要存时区偏移。

### 0x17 与 struct tm 对照

C 标准库的 `struct tm` 字段：

| 字段 | 含义 | 范围 |
| ---- | ---- | ---- |
| tm_year | 从 1900 起的年数 | 126 = 2026 |
| tm_mon | 月 | 0 ~ 11 |
| tm_mday | 日 | 1 ~ 31 |
| tm_hour | 时 | 0 ~ 23 |
| tm_min | 分 | 0 ~ 59 |
| tm_sec | 秒 | 0 ~ 60（闰秒） |

自己写转换时注意 `tm_year` 的 1900 偏移和 `tm_mon` 的 0 起始，这两个是最容易错的。

## 0x20 BKP 备份寄存器

BKP（Backup Registers）是备份域里的一组 16 位寄存器，F103 中容量/小容量型号有 **10 个（BKP_DR1 ~ DR10）**。

特点：

- 由 **VBAT** 供电（1.8 ~ 3.6 V），VDD 掉电后仍然保持；
- 系统复位、电源复位都不会清零；
- 只有**备份域复位**（侵入检测、`BKP_DeInit`）才会清空；
- 可以存用户数据，也可以存 RTC 校准值；
- 支持 **TAMPER 侵入检测**：检测到入侵事件时清空所有备份寄存器。

典型用途：

- 存“RTC 是否已经初始化过”的标志（避免每次上电都重设时间）；
- 存设备序列号、校准参数、运行时长；
- 存掉电前的状态，开机恢复。

### 0x21 备份域复位

备份域复位源：

- 上电复位（POR）；
- `BKP_DeInit()` 软件复位；
- TAMPER 检测到入侵；
- 从 Standby 唤醒（部分型号）。

所以“备份寄存器没保住”先查：VBAT 有没有电、有没有误触发 TAMPER、代码里有没有调 `BKP_DeInit`。

### 0x22 TAMPER 侵入检测

BKP 支持 TAMPER 引脚（PC13），检测到电平/边沿变化时清空所有备份寄存器，并置 TAMPER 标志：

```c
void BKP_Tamper_Init(void)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_PWR, ENABLE);
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_BKP, ENABLE);
    PWR_BackupAccessCmd(ENABLE);

    BKP_TamperPinLevelConfig(BKP_TamperPinLevel_High);
    BKP_TamperPinCmd(ENABLE);
    BKP_ITConfig(ENABLE);
}
```

TAMPER 中断里可以做“记录入侵时间/报警”。注意：**TAMPER 一触发，BKP 和 RTC 配置都会被清**，时间需要重新设置。产品不需要防拆时最好关闭，避免误触发。

### 0x23 用 BKP 存设备参数

10 个 16 位寄存器就是 20 字节，够存不少“小而重要”的数据：

```c
typedef struct
{
    uint16_t Magic;       /* 0x5A5A */
    uint16_t Serial;      /* 设备编号 */
    uint32_t RunHours;    /* 运行小时数 */
    uint16_t Calib;       /* 校准值 */
    uint16_t Crc;
} BkpData;

void BKP_Save(BkpData *Data)
{
    BKP_WriteBackupRegister(BKP_DR2, Data->Magic);
    BKP_WriteBackupRegister(BKP_DR3, Data->Serial);
    BKP_WriteBackupRegister(BKP_DR4, Data->RunHours & 0xFFFF);
    BKP_WriteBackupRegister(BKP_DR5, Data->RunHours >> 16);
    BKP_WriteBackupRegister(BKP_DR6, Data->Calib);
    BKP_WriteBackupRegister(BKP_DR7, Data->Crc);
}
```

读写 BKP 不需要“擦除”，也不怕频繁写（它是寄存器，不是 Flash），非常适合存“掉电前状态”。

### 0x24 BKP 与 RTC 的分工

- **BKP**：存标志、参数、运行时长；
- **RTC**：只负责“现在几点”；
- 不要把大量数据塞 BKP（只有 20 字节），大块数据放 Flash/EEPROM。

### 0x25 掉电检测与恢复

主电源掉电时，如果来不及保存状态，可以靠 BKP 的“掉电标志”判断：

```c
/* 上电时 */
if (BKP_ReadBackupRegister(BKP_DR8) == 0xDEAD)
{
    /* 上次是掉电复位，恢复运行时长等状态 */
    BKP_WriteBackupRegister(BKP_DR8, 0x0000);
}

/* 检测到电压低时（PVD 中断） */
BKP_WriteBackupRegister(BKP_DR8, 0xDEAD);
```

PVD 阈值设 2.9 V，电压跌到阈值时进中断，趁电容余电把关键状态写进 BKP，比写 Flash 快得多。

### 0x26 BKP 的写寿命

BKP 是触发器/寄存器，不是 Flash，写次数几乎不受限（按设计可无限写）。但它是**备份域**资源：

- 写之前必须解除 DBP 保护；
- 掉电瞬间写可能丢失（VBAT 供电时不会）；
- 不要在主循环里高频写，没必要且增加功耗。

### 0x27 备份域初始化顺序

正确的顺序：

```text
1. 开 PWR 时钟
2. 开 BKP 时钟
3. PWR_BackupAccessCmd(ENABLE)   // 解除 DBP
4. 读 BKP_DR1 判断是否首次
5. 首次：开 LSE → 等稳定 → 选 RTC 时钟 → RTCEN
6. 等 RSF → 设 PRL → 设 CNT → 写 BKP 标志
7. 非首次：等 RSF，直接读时间
```

顺序错一步就可能“写不进去”或“读出来是 0”。尤其是第 3 步，很多人忘了解除 DBP，后面所有写操作都无效。

## 0x30 RTC 实时时钟

![RTC 框图](/images/posts/stm32-rtc/rtc-diagram.webp)

RTC 是一个**独立的定时器**，在备份域里运行：

- 时钟源三选一：**LSE（32.768 kHz 外部晶振）**、LSI（约 40 kHz 内部 RC）、HSE/128；
- 32 位可编程计数器，本质上就是 Unix 时间戳；
- 20 位预分频器，把 32.768 kHz 分频成 1 Hz；
- 支持秒中断、闹钟（ALR）、溢出中断；
- 主电源掉电后由 VBAT 继续供电，时间不停。

### 0x31 为什么是 32.768 kHz

32768 = 2^15，15 级二分频正好得到 1 Hz，分频电路最简单、最省电。几乎所有 RTC 晶振都是 32.768 kHz。

### 0x32 时钟源选择

| 时钟源 | 频率 | 精度 | 功耗 | 适用 |
| ------ | ---- | ---- | ---- | ---- |
| LSE | 32.768 kHz | 高（晶振） | 低 | 正式产品 |
| LSI | 约 40 kHz | 低（RC，±50%） | 低 | 低成本、精度要求低 |
| HSE/128 | 主晶振分频 | 高 | 高（主晶振常开） | 特殊场合 |

RTC 时钟源在 `RCC_BDCR` 里选：

```c
RCC_RTCCLKConfig(RCC_RTCCLKSource_LSE);
RCC_RTCCLKCmd(ENABLE);
```

### 0x33 预分频与计数器

```text
RTC 计数频率 = RTC 时钟 / (PRL + 1)
```

LSE 32.768 kHz、PRL = 32767：

```text
32768 / (32767 + 1) = 1 Hz
```

所以 CNT 每秒 +1，直接就是时间戳。

### 0x34 闹钟与中断

- **ALR**：设定一个比较值，CNT == ALR 时置 ALRF，可产生中断；
- **秒中断**：每秒置 SECF；
- **溢出**：CNT 从 0xFFFFFFFF 回 0 时置 OWF。

闹钟可以用来“每天 8 点唤醒”，秒中断可以用来刷新显示。

### 0x35 影子寄存器与同步

RTC 的**预分频（PRL）和闹钟（ALR）有影子寄存器**，计数器 CNT 是实际计数器：

- 写 `PRL/ALR` 写的是“待更新值”，要等更新事件才搬到工作寄存器；
- 写 `CNT` 是直接装载计数器（写完仍建议等 RTOFF）；
- 读 `CNT` 经 APB 同步，读之前要等 **RSF**（寄存器同步标志）；
- 每次写操作要等 **RTOFF**（上一次写完成）。

标准库封装：

```c
RTC_WaitForSynchro();     /* 等 RSF */
RTC_WaitForLastTask();    /* 等 RTOFF */
```

### 0x36 寄存器级操作（不依赖库）

标准库封装很方便，但排障时直接看寄存器更快：

```c
void RTC_SetPrescaler_Reg(uint32_t Prescaler)
{
    RTC_WaitForSynchro();                 /* 等 RSF */

    RTC->CRL |= RTC_CRL_CNF;              /* 进入配置模式 */
    RTC->PRL = Prescaler;                 /* 写预分频 */
    RTC->CRL &= ~RTC_CRL_CNF;             /* 退出配置模式 */

    while ((RTC->CRL & RTC_CRL_RTOFF) == 0);   /* 等写完成 */
}

uint32_t RTC_GetCounter_Reg(void)
{
    return RTC->CNT;
}
```

关键位：

- `RTC_CRL_CNF`：配置模式；
- `RTC_CRL_RTOFF`：上一次写完成；
- `RTC_CRL_RSF`：寄存器同步；
- `RTC_CRH_SECIE/ALRIE/OWIE`：中断使能；
- `RTC_CRL_SECF/ALRF/OWF`：中断标志。

### 0x37 RTC 校准

晶振有频偏，可以用 `BKP_RTCCR` 的 CAL[6:0] 做数字校准。每步约 **0.954 ppm**：

- CAL = 0：不校准；
- CAL = 0~63：把 RTC **放慢** CAL × 0.954 ppm；
- CAL = 64~127：把 RTC **加快** (127 − CAL) × 0.954 ppm，CAL=127 相当于不加快。

所以校准范围约 ±60 ppm，不是 ±120。

```c
void RTC_Calibrate(int8_t ppm)
{
    int32_t Steps = (int32_t)((ppm < 0 ? -ppm : ppm) / 0.954f + 0.5f);
    uint32_t Cal;

    if (Steps > 63) Steps = 63;

    if (ppm >= 0) Cal = (uint32_t)Steps;          /* 放慢：0~63 */
    else          Cal = 127 - (uint32_t)Steps;    /* 加快：64~127 */

    BKP->RTCCR = (BKP->RTCCR & ~0x7F) | (Cal & 0x7F);
}
```

写 `BKP_RTCCR` 前同样要 `PWR_BackupAccessCmd(ENABLE)`。校准前先用“24 小时误差”算出 ppm：

```text
ppm = (实测误差秒数 / 86400) × 1e6
```

### 0x39 用 LSI 时的校准

LSI 是内部 RC，频率 30 ~ 60 kHz，误差很大。没有 LSE 时可以用 HSE 测出实际频率：

```text
用 TIM 以 HSE 计时 1 秒，同时数 LSI 周期数 N
LSI 实际频率 ≈ N Hz
预分频 PRL = N - 1
```

流程：

1. 配 TIM 为 1 秒定时；
2. 把 LSI 接到 TIM 的 ETR/捕获脚（部分型号支持）；
3. 读计数，算 PRL；
4. 写入 RTC。

没有硬件通路时，只能“跑 24 小时对表”手动校准。LSI 温度漂移大，不适合做长期时钟。

### 0x3A 时钟源切换

LSE 起振失败时可以退回 LSI：

```c
if (RCC_GetFlagStatus(RCC_FLAG_LSERDY) == RESET)
{
    RCC_RTCCLKConfig(RCC_RTCCLKSource_LSI);
}
```

切换时钟源后要重新设预分频（LSI 约 40 kHz → PRL = 39999），并重新校准时间。

## 0x40 备份域访问

备份域不是随时能写的，要按顺序来：

1. 开 **PWR** 时钟（`RCC_APB1Periph_PWR`）；
2. 开 **BKP** 时钟（`RCC_APB1Periph_BKP`）；
3. 调 `PWR_BackupAccessCmd(ENABLE)` 解除备份域写保护（置 DBP 位）；
4. 写 BKP/RTC 寄存器。

RTC 还有两条同步规则：

- 读 RTC 寄存器前，如果 APB1 之前是停止状态，要等 `RSF`；
- 每次写 RTC 寄存器后要等 `RTOFF`；
- 写之前要进配置模式（`CNF`），标准库的 `RTC_SetCounter` / `RTC_SetPrescaler` 内部会处理。

### 0x41 备份域寄存器

| 寄存器 | 作用 |
| ------ | ---- |
| `RCC_BDCR` | LSE 使能/就绪、RTC 时钟源、RTCEN、备份域复位 |
| `PWR_CR` | DBP 位（解除备份域写保护） |
| `BKP_DR1~DR10` | 备份数据 |
| `BKP_RTCCR` | RTC 校准、秒脉冲输出 |
| `RTC_CRH/CRL` | 中断使能、标志、CNF、RTOFF |
| `RTC_PRL` | 预分频装载值 |
| `RTC_CNT` | 计数器 |
| `RTC_ALR` | 闹钟值 |

## 0x50 硬件设计

### 0x51 LSE 晶振

![LSE 晶振电路](/images/posts/stm32-rtc/lse-crystal.webp)

LSE 接在 OSC32_IN / OSC32_OUT（PC14/PC15），晶振旁边配负载电容：

```text
CL1 = CL2 ≈ 2 × (CL - Cstray)
```

晶振负载电容 CL 通常 6 ~ 12.5 pF，PCB 杂散电容约 3 ~ 5 pF。例如 CL = 12.5 pF、Cstray = 3 pF：

```text
CL1 = CL2 ≈ 2 × (12.5 - 3) ≈ 19 pF
```

实际取值 10 ~ 22 pF 都常见，要看晶振手册。电容太大会起振慢、太小会频率偏。

### 0x52 VBAT 供电

- VBAT 接纽扣电池（CR2032，3 V）或超级电容；
- VBAT 和 VDD 之间通常有二极管/切换电路，VDD 掉电时自动切到 VBAT；
- VBAT 引脚要加 100 nF 去耦；
- 电池座注意正负极，反接会烧。

### 0x53 电池寿命

RTC + BKP 的备份电流约 **1 ~ 2 µA**（LSE 运行时）。CR2032 容量约 220 mAh：

```text
寿命 ≈ 220 mAh / 1.5 µA ≈ 146,000 小时 ≈ 16 年
```

实际受电池自放电、温度影响，一般按 5 ~ 10 年估算。超级电容（0.1 F）只能撑几天到几周。

### 0x54 PCB 布局

- 晶振尽量靠近芯片，走线短、包地；
- 晶振下方不要走其他信号；
- VBAT 走线远离高频；
- 电池座放在板边，方便更换。

### 0x55 电池与充电电路

- **纽扣电池**：CR2032 正极经二极管接 VBAT，防止 VDD 给电池充电；
- **超级电容**：0.1 ~ 1 F，适合“短时间掉电保持”，上电时通过电阻限流充电；
- **可充电纽扣**（LIR2032）：要加充电电路，不能直接当一次性电池用；
- VBAT 引脚加 100 nF 去耦，电池座远离发热器件。

如果产品长期插电，也可以不用电池，改用“上电从网络/NTP 对时”。

### 0x56 温度补偿

32.768 kHz 晶振的频率-温度曲线近似抛物线：

```text
ppm ≈ -0.035 × (T - 25)²
```

25 °C 时最准，0 °C 或 50 °C 时约 -21 ppm（约 1.8 秒/天）。简易补偿：

1. 用内部温度传感器读温度；
2. 按曲线算 ppm；
3. 调 `BKP_RTCCR` 的 CAL 值。

```c
void RTC_TempCompensate(float Temperature)
{
    float ppm = -0.035f * (Temperature - 25.0f) * (Temperature - 25.0f);
    RTC_Calibrate((int8_t)ppm);
}
```

内部温度传感器精度只有 ±1.5 °C，补偿效果有限；高精度场合用 TCXO 或外部温度补偿 RTC（DS3231）。

## 0x60 代码实现

本篇代码文件：

| 文件 | 作用 |
| ---- | ---- |
| `MyRTC.h` / `MyRTC.c` | BKP 读写、RTC 初始化、时间戳转换 |
| `main.c` | OLED 显示日期时间 |

### 0x61 BKP 读写

```c
void BKP_Test(void)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_PWR, ENABLE);
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_BKP, ENABLE);
    PWR_BackupAccessCmd(ENABLE);

    BKP_WriteBackupRegister(BKP_DR2, 0x1234);
    uint16_t Value = BKP_ReadBackupRegister(BKP_DR2);
}
```

`BKP_DR1` 通常留给“初始化标志”，用户数据从 `BKP_DR2` 开始。

### 0x62 RTC 初始化

```c
void MyRTC_Init(void)
{
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_PWR, ENABLE);
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_BKP, ENABLE);
    PWR_BackupAccessCmd(ENABLE);

    if (BKP_ReadBackupRegister(BKP_DR1) != 0xA5A5)
    {
        /* 第一次上电：启动 LSE */
        RCC_LSEConfig(RCC_LSE_ON);
        while (RCC_GetFlagStatus(RCC_FLAG_LSERDY) == RESET);

        RCC_RTCCLKConfig(RCC_RTCCLKSource_LSE);
        RCC_RTCCLKCmd(ENABLE);

        RTC_WaitForSynchro();
        RTC_WaitForLastTask();

        RTC_SetPrescaler(32768 - 1);   /* 1Hz */
        RTC_WaitForLastTask();

        MyRTC_SetTime(2026, 11, 6, 23, 0, 0);

        BKP_WriteBackupRegister(BKP_DR1, 0xA5A5);
    }
    else
    {
        /* 已经初始化过，等同步即可 */
        RTC_WaitForSynchro();
        RTC_WaitForLastTask();
    }
}
```

### 0x63 时间戳与日期互转

```c
static uint8_t IsLeapYear(uint16_t year)
{
    return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
}

uint32_t MyRTC_TimeToStamp(uint16_t year, uint8_t month, uint8_t day,
                           uint8_t hour, uint8_t minute, uint8_t second)
{
    static const uint8_t monthDays[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    uint32_t days = 0;

    for (uint16_t y = 1970; y < year; y++)
    {
        days += IsLeapYear(y) ? 366 : 365;
    }

    for (uint8_t m = 1; m < month; m++)
    {
        days += monthDays[m - 1];
        if (m == 2 && IsLeapYear(year)) days++;
    }

    days += day - 1;
    return days * 86400 + hour * 3600 + minute * 60 + second;
}

void MyRTC_StampToTime(uint32_t stamp, uint16_t *year, uint8_t *month, uint8_t *day,
                       uint8_t *hour, uint8_t *minute, uint8_t *second)
{
    static const uint8_t monthDays[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    uint32_t days = stamp / 86400;
    uint32_t rem = stamp % 86400;
    uint16_t y = 1970;
    uint8_t m = 1;

    *hour = rem / 3600;
    *minute = (rem % 3600) / 60;
    *second = rem % 60;

    while (days >= (IsLeapYear(y) ? 366u : 365u))
    {
        days -= IsLeapYear(y) ? 366u : 365u;
        y++;
    }

    while (days >= (uint32_t)monthDays[m - 1] + ((m == 2 && IsLeapYear(y)) ? 1 : 0))
    {
        days -= monthDays[m - 1] + ((m == 2 && IsLeapYear(y)) ? 1 : 0);
        m++;
    }

    *year = y;
    *month = m;
    *day = days + 1;
}
```

### 0x64 设置与读取

```c
void MyRTC_SetTime(uint16_t year, uint8_t month, uint8_t day,
                   uint8_t hour, uint8_t minute, uint8_t second)
{
    uint32_t stamp = MyRTC_TimeToStamp(year, month, day, hour, minute, second);
    RTC_SetCounter(stamp);
    RTC_WaitForLastTask();
}

uint32_t MyRTC_GetTime(void)
{
    return RTC_GetCounter();
}

void MyRTC_GetDate(uint16_t *year, uint8_t *month, uint8_t *day,
                   uint8_t *hour, uint8_t *minute, uint8_t *second)
{
    MyRTC_StampToTime(RTC_GetCounter(), year, month, day, hour, minute, second);
}
```

### 0x65 主程序（OLED 时钟）

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "OLED.h"
#include "MyRTC.h"

int main(void)
{
    uint16_t year;
    uint8_t month, day, hour, minute, second;

    OLED_Init();
    MyRTC_Init();

    OLED_ShowString(1, 1, "20  -  -  ");
    OLED_ShowString(2, 1, "  :  :  ");

    while (1)
    {
        MyRTC_GetDate(&year, &month, &day, &hour, &minute, &second);

        OLED_ShowNum(1, 3, year, 4);
        OLED_ShowNum(1, 8, month, 2);
        OLED_ShowNum(1, 11, day, 2);
        OLED_ShowNum(2, 1, hour, 2);
        OLED_ShowNum(2, 4, minute, 2);
        OLED_ShowNum(2, 7, second, 2);

        Delay_ms(100);
    }
}
```

### 0x66 秒中断

```c
void MyRTC_IT_Init(void)
{
    RTC_ITConfig(RTC_IT_SEC, ENABLE);
    RTC_WaitForLastTask();

    NVIC_PriorityGroupConfig(NVIC_PriorityGroup_2);
    NVIC_InitTypeDef NVIC_InitStructure;
    NVIC_InitStructure.NVIC_IRQChannel = RTC_IRQn;
    NVIC_InitStructure.NVIC_IRQChannelCmd = ENABLE;
    NVIC_InitStructure.NVIC_IRQChannelPreemptionPriority = 2;
    NVIC_InitStructure.NVIC_IRQChannelSubPriority = 1;
    NVIC_Init(&NVIC_InitStructure);
}

void RTC_IRQHandler(void)
{
    if (RTC_GetITStatus(RTC_IT_SEC) == SET)
    {
        RTC_ClearITPendingBit(RTC_IT_SEC);
        RTC_WaitForLastTask();
        /* 置刷新标志，主循环刷新显示 */
    }
}
```

### 0x67 闹钟

```c
void MyRTC_SetAlarm(uint32_t Stamp)
{
    RTC_SetAlarm(Stamp);
    RTC_WaitForLastTask();
}

void RTC_Alarm_IRQHandler(void)
{
    if (RTC_GetITStatus(RTC_IT_ALR) == SET)
    {
        RTC_ClearITPendingBit(RTC_IT_ALR);
        RTC_WaitForLastTask();
        /* 闹钟动作 */
    }
}
```

闹钟中断要同时开 `RTC_IT_ALR` 和 EXTI Line17（`EXTI_Line17`），标准库的 `RTC_ITConfig` 只开 RTC 侧。

### 0x68 RTC 闹钟唤醒 Stop

低功耗设备常做“Stop + RTC 闹钟唤醒”：

```c
void Enter_Stop_Until(uint32_t WakeStamp)
{
    RTC_SetAlarm(WakeStamp);
    RTC_WaitForLastTask();

    RTC_ITConfig(RTC_IT_ALR, ENABLE);
    RTC_WaitForLastTask();

    PWR_EnterSTOPMode(PWR_Regulator_LowPower, PWR_STOPEntry_WFI);

    /* 唤醒后时钟变 HSI，要重配 */
    SystemInit();
}
```

闹钟中断：

```c
void RTC_Alarm_IRQHandler(void)
{
    if (RTC_GetITStatus(RTC_IT_ALR) == SET)
    {
        RTC_ClearITPendingBit(RTC_IT_ALR);
        RTC_WaitForLastTask();
    }
}
```

注意：

- 闹钟中断要配 EXTI Line17 和 NVIC；
- Stop 下 RTC 仍在走，闹钟能唤醒；
- 唤醒后外设要重新初始化（串口、定时器）。

## 0x70 实验与调试

### 0x71 确认 LSE 起振

```c
RCC_LSEConfig(RCC_LSE_ON);
while (RCC_GetFlagStatus(RCC_FLAG_LSERDY) == RESET);
```

如果卡在这里：

- 晶振/负载电容不对；
- PCB 布线太长；
- 晶振坏了。

可以在等待循环里加超时，失败就退回 LSI。

### 0x72 测时间精度

让 RTC 走 24 小时，和手机/NTP 对时：

- 误差几秒/天：正常（晶振 ±20 ppm ≈ 1.7 s/天）；
- 误差几分钟/天：负载电容不对或用了 LSI；
- 误差忽大忽小：晶振受温度/干扰。

### 0x73 掉电保持

- 拔掉 VDD，只留 VBAT，等 10 秒再上电；
- 时间应继续走，BKP 标志还在；
- 如果归零，查 VBAT 电压、电池、TAMPER。

### 0x74 2038 与溢出

把 CNT 设成 `0x7FFFFFF0` 附近，观察跨过 2038 时的显示；再用 `0xFFFFFF00` 观察 2106 溢出。测试边界能提前发现符号/回绕 bug。

### 0x75 串口对时

产品没有网络时，可以用上位机串口下发时间：

```text
T2026-11-06 23:00:00\n
```

解析并设置：

```c
void Time_Sync_Handler(char *Line)
{
    int y, mo, d, h, mi, s;

    if (Line[0] != 'T') return;

    if (sscanf(Line + 1, "%d-%d-%d %d:%d:%d", &y, &mo, &d, &h, &mi, &s) == 6)
    {
        MyRTC_SetTime(y, mo, d, h, mi, s);
    }
}
```

`sscanf` 占空间较大，资源紧张时自己解析数字。对时后建议把“已校准”标志写进 BKP，下次上电不重复设置。

### 0x76 时间格式化

显示/日志常用字符串：

```c
char TimeStr[20];

snprintf(TimeStr, sizeof(TimeStr), "%04d-%02d-%02d %02d:%02d:%02d",
         year, month, day, hour, minute, second);
```

LCD 段码/数码管常用 BCD：

```c
uint8_t ToBCD(uint8_t Value)
{
    return ((Value / 10) << 4) | (Value % 10);
}

uint8_t FromBCD(uint8_t BCD)
{
    return (BCD >> 4) * 10 + (BCD & 0x0F);
}
```

### 0x77 时区与夏令时

时间戳是 UTC，显示本地时间时加偏移：

```c
int8_t TimeZone = 8;   /* UTC+8 */
uint32_t localStamp = utcStamp + TimeZone * 3600;
```

有夏令时的地区要按规则加减 1 小时（中国目前不用）。存储时仍然存 UTC，只在显示层转换，避免“存进去的时间随设置变化”。

### 0x78 多设备对时

- 有网络：NTP/SNTP；
- 有 GPS：解析 NMEA 的 `$GPRMC`；
- 有上位机：串口下发；
- 都没有：出厂时校准，靠 RTC 自身精度。

对时后把“校准时间”写进 BKP，下次上电判断“是否需要重新对时”。

### 0x79 做一个 OLED 时钟界面

简单的时钟界面：

```text
┌────────────────┐
│   2026-11-06   │
│    23:00:00    │
│  周 五  25.3°C │
└────────────────┘
```

刷新策略：

- 秒变化才刷新秒位，避免整屏闪烁；
- 冒号每秒闪烁（`:` / ` ` 交替）；
- 星期由时间戳算：`(days + 4) % 7`（1970-01-01 是周四）；
- 温度可以每 10 秒读一次，不必每秒。

刷新太频繁会占用 I2C/SPI 带宽，OLED 也可能闪烁；按“变化的字段”局部刷新最稳。

### 0x7A 三个常见设计错误

**错误 1：用 RTC 做长延时**

RTC 精度是“秒级”，做 100 ms 延时要用定时器，不要用 RTC 轮询。

**错误 2：每次上电都重设时间**

没判断 BKP 标志，导致掉电后时间被“重置为编译时间”。正确做法是 DR1 魔数 + 只在首次设置。

**错误 3：把时间存成本地时间**

存 UTC、显示时加时区；否则改时区/夏令时后历史数据全乱。

### 0x7B 对时方式的取舍

| 方式 | 精度 | 成本 | 适用 |
| ---- | ---- | ---- | ---- |
| 出厂校准 | 取决于晶振 | 0 | 简单设备 |
| 串口对时 | 秒级 | 低 | 有上位机 |
| GPS | 微秒级 | 中 | 户外/车载 |
| NTP | 毫秒级 | 需要网络 | 联网设备 |
| 手动按键 | 秒级 | 低 | 家电 |

大多数产品用“出厂校准 + 偶尔串口对时”就够了；RTC 的日误差一般在 1 ~ 2 秒，一个月差一分钟很正常。

## 0x80 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| RTC 不走 | LSE 没起振、没选 RTC 时钟源 | 等 LSERDY、查晶振/电容 |
| 掉电归零 | VBAT 没电、TAMPER 触发 | 查电池、`BKP_DeInit` |
| 每次上电都重设 | 没用 BKP 标志 | 写 DR1 魔数判断 |
| 写 RTC 不生效 | 没解除备份域写保护 | `PWR_BackupAccessCmd` |
| 读出来差 8 小时 | 时间戳是 UTC | 显示加时区偏移 |
| 年份算错 | 闰年判断漏整百年 | 用 `%4/%100/%400` |
| 2038 变负数 | 用有符号 32 位 | 用 `uint32_t` |
| 闹钟不进中断 | 没开 EXTI17/NVIC | 配 EXTI + NVIC |
| 秒中断丢 | 没清 SECF/没等 RTOFF | 清标志 + `RTC_WaitForLastTask` |
| 走时偏快/偏慢 | 负载电容不对 | 按晶振 CL 计算 |
| LSE 起振慢 | 电容太大/晶振差 | 减小电容、换晶振 |
| 备份寄存器丢失 | 误调 `BKP_DeInit` | 检查初始化代码 |

## 0x90 小结

| 模块 | 作用 | 关键点 |
| ---- | ---- | ------ |
| Unix 时间戳 | 秒数表示时间 | UTC、闰年、2038 |
| BKP | 掉电保存的 16 位寄存器 | VBAT 供电、复位不清、DR1 做标志 |
| RTC | 独立计时 | LSE 32.768 kHz、32768 分频、32 位计数 |
| 备份域访问 | 写保护 | PWR+BKP 时钟、DBP、等待同步 |
| 闹钟/秒中断 | 定时事件 | ALR/SECF、EXTI17 |

### 思考题

1. 为什么 RTC 用 32.768 kHz 而不是 32 kHz？
2. 时间戳为什么用 UTC，显示时怎么处理时区？
3. BKP 的“备份域复位”有哪些触发源？
4. RTC 写操作为什么要等 RTOFF？
5. 2038 问题在 STM32 上为什么可以推到 2106？

RTC 的硬件很简单，难的是“第一次初始化”和“掉电保持”这两件事。用 BKP 存一个魔数做标志，是嵌入式里非常常用的小技巧。
