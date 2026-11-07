+++
title = "STM32 硬件 SPI：外设、连续传输、DMA 与 W25Q64"
date = "2026-11-04T21:00:00+08:00"
lastmod = "2026-11-06T23:59:00+08:00"
draft = false
description = "把软件 SPI 的时序交给 SPI1/SPI2 外设：讲清 CR1/CR2/SR、NSS 软件模式、波特率分频、连续/非连续传输、只发/只收、DMA 刷屏，给出硬件 SPI 驱动 W25Q64 的完整 .h/.c/main.c 与 12 条故障排查。"
categories = [ "STM32" ]
tags = [ "STM32", "SPI", "W25Q64", "DMA" ]
cover = "/images/pool/covers/covers-14.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 11 章后半（11-4、11-5）。

代码基于 **STM32F103C8T6 + STM32F10x 标准外设库 3.5.0**（API 已按 STM32F10x StdPeriph 3.5 头文件核对；Delay/OLED/Key 为课程配套驱动），不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 11-4 | SPI 外设简介、框图、主模式全双工连续传输、非连续传输、状态寄存器 | 0x00 ~ 0x50 |
| 11-5 | 硬件 SPI 读写 W25Q64（代码、与软件对比） | 0x50 ~ 0x70 |

视频之外还补了：CR1/CR2/SR 逐位说明、NSS 软件模式、DMA 刷屏、SPI 中断、W25Q64 完整驱动、12 条故障排查。

## 0x00 硬件 SPI 与软件 SPI

软件 SPI 用 GPIO 翻转 SCK，每个位都要 CPU 执行几条指令；硬件 SPI 把移位、时钟、采样都交给外设，CPU 只读写 `DR`、等标志。

F103C8T6 有 **SPI1 和 SPI2**：

| 外设 | 总线 | 默认引脚 | 重映射 |
| ---- | ---- | -------- | ------ |
| SPI1 | APB2（72 MHz） | PA4(NSS)、PA5(SCK)、PA6(MISO)、PA7(MOSI) | PB3/PB4/PB5 |
| SPI2 | APB1（36 MHz） | PB12(NSS)、PB13(SCK)、PB14(MISO)、PB15(MOSI) | — |

SPI1 重映射到 PB3/PB4/PB5 会和 JTAG 冲突，需要先关 JTAG（保留 SWD），否则 PB3/PB4 被占用。

| 项目 | 软件 SPI | 硬件 SPI |
| ---- | -------- | -------- |
| 引脚 | 任意 GPIO | 固定/重映射 |
| 速度 | 几百 kHz ~ 几 MHz | 最高 18 MHz（SPI1） |
| CPU | 每位翻转 | 读写 DR + 等标志 |
| 时序 | 受中断影响 | 硬件保证 |
| 代码 | 全手写 | 配 CR1/CR2 |

## 0x10 SPI 外设结构

![STM32 SPI 框图](/images/posts/stm32-spi-hw/spi-block.webp)

框图里的核心部件：

- **发送缓冲区 / 接收缓冲区**：就是 `DR` 的两个方向；
- **移位寄存器**：把字节按位串行移出/移入；
- **波特率发生器**：由 `fPCLK` 分频，分频系数 2/4/8/…/256；
- **主控制电路**：产生 SCK、管理 NSS；
- **CR1/CR2**：模式、数据宽度、CPOL/CPHA、中断/DMA；
- **SR**：TXE、RXNE、BSY、OVR、MODF 等状态。

一次“交换”的流程：

1. 写 `DR` → TXE 清零；
2. 硬件把数据移到移位寄存器，TXE 重新置 1；
3. 8 个时钟后，接收到的字节进接收缓冲区，RXNE 置 1；
4. 读 `DR` → RXNE 清零。

所以**发一个字节的同时必然收一个字节**，哪怕你根本不关心返回值，也要读一次 `DR` 把 RXNE 清掉，否则下一字节会 OVR。

### 0x12 SPI 与 I2C 的工程取舍

- **速度优先**：SPI（屏、Flash、无线）；
- **引脚优先**：I2C（多个慢速传感器）；
- **距离/抗干扰**：RS485/CAN；
- **多设备**：SPI 靠片选，I2C 靠地址。

同一块板子上常常两者都有：EEPROM/传感器走 I2C，屏/Flash 走 SPI。

### 0x13 电平转换与隔离

- 3.3 V 单片机接 5 V 器件：确认引脚 5 V 容忍，或用电平转换芯片（TXB0104、74LVC245）；
- MISO 是输入，5 V 从机输出会超过 3.3 V，必须转换；
- 长线/强干扰：串联 22~100 Ω、加 TVS、用数字隔离器（ADuM3151）；
- 多个从机时，未选中的 MISO 应高阻，否则会拉低总线。

### 0x14 片选与上电顺序

- 上电时先把 CS 拉高，再配置 SPI；
- 从机没上电时，MISO 可能浮空，主机读到随机值；
- 热插拔场景要在协议层做“重新识别”。

## 0x20 寄存器

### 0x21 SPI_CR1

| 位 | 名称 | 作用 |
| -- | ---- | ---- |
| 0 | CPHA | 时钟相位 |
| 1 | CPOL | 时钟极性 |
| 2 | MSTR | 1=主机，0=从机 |
| 3~5 | BR[2:0] | 波特率分频：000=/2，001=/4，…，111=/256 |
| 6 | SPE | SPI 使能 |
| 7 | LSBFIRST | 1=低位先行，0=高位先行 |
| 8 | SSI | 内部 NSS 值（软件模式用） |
| 9 | SSM | 1=软件 NSS |
| 10 | RXONLY | 只收模式 |
| 11 | DFF | 1=16 位数据，0=8 位 |
| 12 | CRCNEXT | 下一个字节发 CRC |
| 13 | CRCEN | 硬件 CRC 使能 |
| 14 | BIDIOE | 双向模式输出使能 |
| 15 | BIDIMODE | 1=单线双向 |

### 0x22 SPI_CR2

| 位 | 名称 | 作用 |
| -- | ---- | ---- |
| 0 | RXDMAEN | 接收 DMA 使能 |
| 1 | TXDMAEN | 发送 DMA 使能 |
| 2 | SSOE | 硬件 NSS 输出使能 |
| 6 | ERRIE | 错误中断 |
| 7 | RXNEIE | 接收非空中断 |
| 8 | TXEIE | 发送空中断 |

### 0x23 SPI_SR

| 位 | 名称 | 含义 |
| -- | ---- | ---- |
| 0 | RXNE | 接收缓冲区非空 |
| 1 | TXE | 发送缓冲区空 |
| 2 | CHSIDE | 声道（I2S 用） |
| 3 | UDR | 下溢 |
| 4 | CRCERR | CRC 错误 |
| 5 | MODF | 模式错误（NSS 冲突） |
| 6 | OVR | 溢出 |
| 7 | BSY | 忙 |

### 0x24 NSS 软件模式

主机模式下如果用硬件 NSS，引脚会被自动拉低/拉高，多从机不好控制。一般用**软件 NSS**：

```c
SPI_InitStructure.SPI_NSS = SPI_NSS_Soft;
```

同时把 `SSI` 置 1（标准库会处理），否则可能触发 `MODF` 模式错误。片选自己用 GPIO 控制。

### 0x25 数据宽度与位序

- `SPI_DataSize_8b`：一次 8 位，最常用；
- `SPI_DataSize_16b`：一次 16 位，适合 LCD、ADC；
- `SPI_FirstBit_MSB`：高位先行，绝大多数器件；
- `SPI_FirstBit_LSB`：低位先行，少数器件（如某些 DAC）。

16 位模式下，`SPI_I2S_SendData()` 一次写 16 位，DMA 的宽度也要改成 HalfWord，否则会错位。

### 0x26 四种模式的配置

```c
/* 模式 0：CPOL=0，CPHA=0 */
SPI_InitStructure.SPI_CPOL = SPI_CPOL_Low;
SPI_InitStructure.SPI_CPHA = SPI_CPHA_1Edge;

/* 模式 1：CPOL=0，CPHA=1 */
SPI_InitStructure.SPI_CPOL = SPI_CPOL_Low;
SPI_InitStructure.SPI_CPHA = SPI_CPHA_2Edge;

/* 模式 2：CPOL=1，CPHA=0 */
SPI_InitStructure.SPI_CPOL = SPI_CPOL_High;
SPI_InitStructure.SPI_CPHA = SPI_CPHA_1Edge;

/* 模式 3：CPOL=1，CPHA=1 */
SPI_InitStructure.SPI_CPOL = SPI_CPOL_High;
SPI_InitStructure.SPI_CPHA = SPI_CPHA_2Edge;
```

标准库的 `SPI_CPHA_1Edge` 对应 CPHA=0（第一个边沿采样），`SPI_CPHA_2Edge` 对应 CPHA=1。名字容易记反，配置后一定用逻辑分析仪确认。

### 0x28 从机模式配置

```c
void MySPI_Slave_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_SPI1, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_5 | GPIO_Pin_7;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_6;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;   /* NSS 输入 */
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_4;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    SPI_InitTypeDef SPI_InitStructure;
    SPI_InitStructure.SPI_Direction = SPI_Direction_2Lines_FullDuplex;
    SPI_InitStructure.SPI_Mode = SPI_Mode_Slave;
    SPI_InitStructure.SPI_DataSize = SPI_DataSize_8b;
    SPI_InitStructure.SPI_CPOL = SPI_CPOL_Low;
    SPI_InitStructure.SPI_CPHA = SPI_CPHA_1Edge;
    SPI_InitStructure.SPI_NSS = SPI_NSS_Hard;
    SPI_InitStructure.SPI_BaudRatePrescaler = SPI_BaudRatePrescaler_2;  /* 从机忽略 */
    SPI_InitStructure.SPI_FirstBit = SPI_FirstBit_MSB;
    SPI_Init(SPI1, &SPI_InitStructure);

    SPI_Cmd(SPI1, ENABLE);
}
```

从机的 SCK 由主机提供，`BaudRatePrescaler` 无效；NSS 必须用硬件（或被主机拉低），否则不会开始接收。

### 0x29 从机收发

```c
uint8_t SPI_Slave_Transfer(uint8_t ByteSend)
{
    while (SPI_I2S_GetFlagStatus(SPI1, SPI_I2S_FLAG_TXE) == RESET);
    SPI_I2S_SendData(SPI1, ByteSend);

    while (SPI_I2S_GetFlagStatus(SPI1, SPI_I2S_FLAG_RXNE) == RESET);
    return SPI_I2S_ReceiveData(SPI1);
}
```

从机要提前把数据写进 DR，主机拉低 NSS 后才有时钟；如果从机没准备好，主机会读到 0x00/0xFF。

## 0x30 传输模式

### 0x31 连续传输

![SPI 非连续传输时序](/images/posts/stm32-spi-hw/spi-timing.webp)

连续传输（BIDIMODE=0、RXONLY=0）时：

- 写 `DR` → 数据进移位寄存器 → TXE 立刻置 1；
- 可以马上写下一个字节，SCK 不间断；
- 每个字节收完 RXNE 置 1，读 `DR` 清。

适合：连续读 Flash、刷屏、DMA。

### 0x32 非连续传输

每个字节之间可以停，靠软件控制节奏：

- 写 DR，等 TXE；
- 等 RXNE，读 DR；
- 再写下一个。

课程里的 `MySPI_SwapByte()` 就是非连续传输。

### 0x33 只发/只收/半双工

- **只发**：`SPI_Direction_1Line_Tx`，只开 MOSI；
- **只收**：`SPI_Direction_1Line_Rx` 或 `RXONLY`，只开 MISO；
- **半双工**：`SPI_Direction_2Lines_RxOnly` / 单线双向。

W25Q64 是标准全双工，必须用 `SPI_Direction_2Lines_FullDuplex`。

### 0x34 波特率

`SPI_BaudRatePrescaler_x` 把 PCLK 分频：

| 分频 | SPI1（72 MHz） | SPI2（36 MHz） |
| ---- | -------------- | -------------- |
| /2 | 36 MHz | 18 MHz |
| /4 | 18 MHz | 9 MHz |
| /8 | 9 MHz | 4.5 MHz |
| /16 | 4.5 MHz | 2.25 MHz |
| /32 | 2.25 MHz | 1.125 MHz |
| /64 | 1.125 MHz | 562.5 kHz |
| /128 | 562.5 kHz | 281 kHz |
| /256 | 281 kHz | 140 kHz |

调试先用 /128 或 /256，稳定后再提速。

> 注意：表里的 36 MHz 只是分频器的理论输出。F103 数据手册规定 SPI 最高时钟为 **18 MHz**，实际配置不要超过 18 MHz；W25Q64 本身能跑更高，但 MCU 端先到顶。

### 0x35 全双工时序细节

一次 8 位交换的寄存器动作：

1. 写 `DR` → TXE=0；
2. 硬件把 `DR` 搬到移位寄存器 → TXE=1；
3. 8 个 SCK 后，接收移位寄存器满 → RXNE=1；
4. 读 `DR` → RXNE=0。

关键点：

- TXE=1 只表示“可以写下一个”，不表示“已经发完”；
- BSY=1 表示“移位寄存器还在移”，拉 CS 前必须等它清零；
- 连续发送时 TXE 会反复置位，但 RXNE 也必须及时读，否则 OVR。

### 0x36 时钟与功耗

- SPI 时钟越高，功耗越大、波形越差；
- 从机没选中时，SCK 应保持空闲电平；
- 低功耗场合可以在不通信时 `SPI_Cmd(DISABLE)`，或把引脚配成模拟输入；
- 长线、高速时串联电阻、缩短线、加地线。

### 0x37 SPI 时序参数

从机手册一般给这些参数：

| 参数 | 含义 |
| ---- | ---- |
| fSCK | 最大时钟频率 |
| tSU | 数据建立时间（相对采样边沿） |
| tH | 数据保持时间 |
| tCS | 片选建立/保持 |
| tDIS | 输出有效延迟 |

主机配置时：

- 时钟频率 ≤ 从机 fSCK；
- 模式匹配，保证采样边沿落在数据稳定区；
- 片选拉低后等 tCS 再发第一个时钟；
- 最后一个时钟后等 tCHSH 再拉高片选。

软件 SPI 很容易满足这些（因为慢），硬件 SPI 高速时要看示波器。

## 0x40 初始化

### 0x41 GPIO

- SCK、MOSI：`GPIO_Mode_AF_PP`；
- MISO：`GPIO_Mode_IPU`（或浮空）；
- NSS/CS：`GPIO_Mode_Out_PP`（软件模式）。

### 0x42 初始化代码

```c
void MySPI_HW_W_SS(uint8_t Level)
{
    if (Level) GPIO_SetBits(GPIOA, GPIO_Pin_4);
    else       GPIO_ResetBits(GPIOA, GPIO_Pin_4);
}

void MySPI_HW_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_SPI1, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_5 | GPIO_Pin_7;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_6;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_4;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    SPI_InitTypeDef SPI_InitStructure;
    SPI_InitStructure.SPI_Direction = SPI_Direction_2Lines_FullDuplex;
    SPI_InitStructure.SPI_Mode = SPI_Mode_Master;
    SPI_InitStructure.SPI_DataSize = SPI_DataSize_8b;
    SPI_InitStructure.SPI_CPOL = SPI_CPOL_Low;
    SPI_InitStructure.SPI_CPHA = SPI_CPHA_1Edge;
    SPI_InitStructure.SPI_NSS = SPI_NSS_Soft;
    SPI_InitStructure.SPI_BaudRatePrescaler = SPI_BaudRatePrescaler_128;
    SPI_InitStructure.SPI_FirstBit = SPI_FirstBit_MSB;
    SPI_InitStructure.SPI_CRCPolynomial = 7;
    SPI_Init(SPI1, &SPI_InitStructure);

    SPI_Cmd(SPI1, ENABLE);

    MySPI_HW_W_SS(1);
}
```

### 0x43 交换一个字节

```c
uint8_t MySPI_HW_SwapByte(uint8_t ByteSend)
{
    while (SPI_I2S_GetFlagStatus(SPI1, SPI_I2S_FLAG_TXE) == RESET);
    SPI_I2S_SendData(SPI1, ByteSend);

    while (SPI_I2S_GetFlagStatus(SPI1, SPI_I2S_FLAG_RXNE) == RESET);
    return SPI_I2S_ReceiveData(SPI1);
}
```

发完最后一个字节、准备拉高 CS 之前，要等 **BSY** 清零：

```c
while (SPI_I2S_GetFlagStatus(SPI1, SPI_I2S_FLAG_BSY) == SET);
```

BSY 表示移位寄存器还在忙，它没清零就拉 CS，最后一个字节可能被截断。

### 0x44 中断方式完整实现

```c
#define SPI_BUF_SIZE 32

uint8_t SPI_TxBuf[SPI_BUF_SIZE];
uint8_t SPI_RxBuf[SPI_BUF_SIZE];
volatile uint16_t SPI_TxLen, SPI_TxIndex, SPI_RxIndex;

void MySPI_HW_IT_Init(void)
{
    NVIC_InitTypeDef NVIC_InitStructure;
    NVIC_InitStructure.NVIC_IRQChannel = SPI1_IRQn;
    NVIC_InitStructure.NVIC_IRQChannelCmd = ENABLE;
    NVIC_InitStructure.NVIC_IRQChannelPreemptionPriority = 1;
    NVIC_InitStructure.NVIC_IRQChannelSubPriority = 1;
    NVIC_Init(&NVIC_InitStructure);

    SPI_I2S_ITConfig(SPI1, SPI_I2S_IT_TXE, ENABLE);
    SPI_I2S_ITConfig(SPI1, SPI_I2S_IT_RXNE, ENABLE);
}

void MySPI_HW_IT_Send(uint8_t *Buf, uint16_t Len)
{
    for (uint16_t i = 0; i < Len; i++) SPI_TxBuf[i] = Buf[i];

    SPI_TxLen = Len;
    SPI_TxIndex = 0;
    SPI_RxIndex = 0;

    SPI_I2S_ITConfig(SPI1, SPI_I2S_IT_TXE, ENABLE);
}

void SPI1_IRQHandler(void)
{
    if (SPI_I2S_GetITStatus(SPI1, SPI_I2S_IT_TXE) == SET)
    {
        if (SPI_TxIndex < SPI_TxLen)
        {
            SPI_I2S_SendData(SPI1, SPI_TxBuf[SPI_TxIndex++]);
        }
        else
        {
            SPI_I2S_ITConfig(SPI1, SPI_I2S_IT_TXE, DISABLE);
        }
    }

    if (SPI_I2S_GetITStatus(SPI1, SPI_I2S_IT_RXNE) == SET)
    {
        if (SPI_RxIndex < SPI_BUF_SIZE)
        {
            SPI_RxBuf[SPI_RxIndex++] = SPI_I2S_ReceiveData(SPI1);
        }
        else
        {
            (void)SPI_I2S_ReceiveData(SPI1);   /* 丢弃，防 OVR */
        }
    }
}
```

中断方式适合“边发边收”的协议；注意 TXE/RXNE 两个中断都要处理，否则 OVR。

### 0x45 重映射到 PB3/PB4/PB5

SPI1 默认在 PA4~PA7，重映射后到 PB3~PB5：

```c
void MySPI_HW_Remap_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);

    /* 关 JTAG，保留 SWD（PA13/PA14 还能调试） */
    GPIO_PinRemapConfig(GPIO_Remap_SWJ_JTAGDisable, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SPI1, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_3 | GPIO_Pin_5;   /* SCK/MOSI */
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOB, &GPIO_InitStructure);

    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_4;                /* MISO */
    GPIO_Init(GPIOB, &GPIO_InitStructure);

    /* 片选自行选一个空闲 GPIO */
}
```

注意：PB3/PB4 复位后是 JTAG 引脚，不关 JTAG 就配不成 SPI。

## 0x50 W25Q64 硬件 SPI 驱动

W25Q64 的指令和软件 SPI 完全一样，只是把 `MySPI_SwapByte` 换成硬件版本。`W25Q64.h`：

```c
#ifndef __W25Q64_H
#define __W25Q64_H

#include "stm32f10x.h"

void W25Q64_Init(void);
void W25Q64_ReadID(uint8_t *MID, uint16_t *DID);
void W25Q64_ReadData(uint32_t Address, uint8_t *Buffer, uint32_t Count);
void W25Q64_PageProgram(uint32_t Address, uint8_t *Buffer, uint16_t Count);
void W25Q64_SectorErase(uint32_t Address);
void W25Q64_WriteEnable(void);
void W25Q64_WaitBusy(void);

#endif
```

`W25Q64.c`：

```c
#include "W25Q64.h"
#include "MySPI_HW.h"

static void W25Q64_CS(uint8_t Level)
{
    if (Level) GPIO_SetBits(GPIOA, GPIO_Pin_4);
    else       GPIO_ResetBits(GPIOA, GPIO_Pin_4);
}

void W25Q64_ReadID(uint8_t *MID, uint16_t *DID)
{
    W25Q64_CS(0);
    MySPI_HW_SwapByte(0x9F);
    *MID = MySPI_HW_SwapByte(0xFF);
    *DID = MySPI_HW_SwapByte(0xFF);
    *DID <<= 8;
    *DID |= MySPI_HW_SwapByte(0xFF);
    W25Q64_CS(1);

    while (SPI_I2S_GetFlagStatus(SPI1, SPI_I2S_FLAG_BSY) == SET);
}

void W25Q64_WriteEnable(void)
{
    W25Q64_CS(0);
    MySPI_HW_SwapByte(0x06);
    W25Q64_CS(1);
}

void W25Q64_WaitBusy(void)
{
    uint8_t Status;

    do
    {
        W25Q64_CS(0);
        MySPI_HW_SwapByte(0x05);
        Status = MySPI_HW_SwapByte(0xFF);
        W25Q64_CS(1);
    } while (Status & 0x01);
}

void W25Q64_ReadData(uint32_t Address, uint8_t *Buffer, uint32_t Count)
{
    W25Q64_CS(0);
    MySPI_HW_SwapByte(0x03);
    MySPI_HW_SwapByte(Address >> 16);
    MySPI_HW_SwapByte(Address >> 8);
    MySPI_HW_SwapByte(Address);

    for (uint32_t i = 0; i < Count; i++)
    {
        Buffer[i] = MySPI_HW_SwapByte(0xFF);
    }

    W25Q64_CS(1);
}

void W25Q64_PageProgram(uint32_t Address, uint8_t *Buffer, uint16_t Count)
{
    if (Count > 256) Count = 256;

    W25Q64_WriteEnable();

    W25Q64_CS(0);
    MySPI_HW_SwapByte(0x02);
    MySPI_HW_SwapByte(Address >> 16);
    MySPI_HW_SwapByte(Address >> 8);
    MySPI_HW_SwapByte(Address);

    for (uint16_t i = 0; i < Count; i++)
    {
        MySPI_HW_SwapByte(Buffer[i]);
    }

    W25Q64_CS(1);
    W25Q64_WaitBusy();
}

void W25Q64_SectorErase(uint32_t Address)
{
    W25Q64_WriteEnable();

    W25Q64_CS(0);
    MySPI_HW_SwapByte(0x20);
    MySPI_HW_SwapByte(Address >> 16);
    MySPI_HW_SwapByte(Address >> 8);
    MySPI_HW_SwapByte(Address);
    W25Q64_CS(1);

    W25Q64_WaitBusy();
}
```

## 0x60 DMA 与刷屏

### 0x61 SPI + DMA 发送

```c
void MySPI_HW_DMA_Tx(uint8_t *Buffer, uint16_t Length)
{
    DMA_Cmd(DMA1_Channel3, DISABLE);

    DMA1_Channel3->CMAR = (uint32_t)Buffer;
    DMA_SetCurrDataCounter(DMA1_Channel3, Length);

    SPI_I2S_DMACmd(SPI1, SPI_I2S_DMAReq_Tx, ENABLE);
    DMA_Cmd(DMA1_Channel3, ENABLE);

    while (DMA_GetFlagStatus(DMA1_FLAG_TC3) == RESET);
    DMA_ClearFlag(DMA1_FLAG_TC3);

    SPI_I2S_DMACmd(SPI1, SPI_I2S_DMAReq_Tx, DISABLE);
}
```

`SPI1_TX` 固定 `DMA1_Channel3`，`SPI1_RX` 固定 `DMA1_Channel2`。

### 0x62 刷屏流程

```text
显存数组 → DMA1_Ch3 → SPI1->DR → 屏幕
```

1. 拉低屏幕 CS，发“写显存”命令；
2. 启动 DMA 搬 `FrameBuf`；
3. 等 TC；
4. 等 BSY 清零，拉高 CS。

这样 CPU 只负责画图，传输交给 DMA。

### 0x63 SPI 中断

```c
void SPI1_IRQHandler(void)
{
    if (SPI_I2S_GetITStatus(SPI1, SPI_I2S_IT_TXE) == SET)
    {
        /* 写下一个字节，或关中断 */
    }

    if (SPI_I2S_GetITStatus(SPI1, SPI_I2S_IT_RXNE) == SET)
    {
        uint8_t Data = SPI_I2S_ReceiveData(SPI1);
    }
}
```

中断方式适合“边发边处理”的协议；大批量还是 DMA 简单。

### 0x64 DMA 双缓冲

刷屏时一帧几百 KB，单缓冲要等 DMA 传完才能画下一帧。双缓冲：

```c
uint8_t FrameBuf[2][320 * 240 * 2];
volatile uint8_t ActiveBuf;

/* DMA 传完前半/后半各触发一次中断 */
void DMA1_Channel3_IRQHandler(void)
{
    if (DMA_GetITStatus(DMA1_IT_TC3))
    {
        /* 当前缓冲发完，切到另一块 */
        ActiveBuf ^= 1;
        DMA_ClearITPendingBit(DMA1_IT_TC3);
    }
}
```

CPU 画 `FrameBuf[ActiveBuf ^ 1]`，DMA 发 `FrameBuf[ActiveBuf]`，两边互不干扰。F103 的 DMA 没有硬件双缓冲，需要用“两块内存 + 中断切换”实现。

### 0x65 刷屏优化

- **提高 SPI 时钟**：从 /128 降到 /2，帧率线性提升；
- **DMA 传输**：CPU 不参与搬运；
- **双缓冲**：画图和发送并行；
- **局部刷新**：只发改动的区域，而不是整屏；
- **减少 CS 切换**：一次 CS 内连续写多个命令/数据。

以 320×240×2 B = 150 KB 为例，SPI 9 MHz 约 0.13 s 一帧（约 7 fps），18 MHz 约 0.07 s（约 14 fps）；想更高只能上 QSPI/并口。

## 0x70 实验与调试

### 0x71 读 ID

```c
uint8_t MID;
uint16_t DID;

MySPI_HW_Init();
W25Q64_ReadID(&MID, &DID);
printf("MID=0x%02X DID=0x%04X\r\n", MID, DID);
```

预期 `MID=0xEF`、`DID=0x4017`。

### 0x72 逻辑分析仪

抓“读 ID”：

```text
CS↓ | 9F | EF | 40 | 17 | CS↑
```

如果 CLK 有、MOSI 有、MISO 全 FF：查 MISO 引脚、CS、供电、模式。

### 0x73 速度对比

| 方式 | 读 1 KB 耗时（约） |
| ---- | ------------------ |
| 软件 SPI（10 µs 延时） | 80 ~ 100 ms |
| 硬件 SPI /128（562 kHz） | 15 ms |
| 硬件 SPI /8（9 MHz） | 1 ms |
| 硬件 SPI + DMA | 1 ms，CPU 接近 0 |

### 0x74 常见波形问题

- CS 拉高太早：最后一个字节丢；
- SCK 空闲电平不对：模式错；
- MISO 中间塌陷：多个 CS 同时有效；
- 时钟太快：数据错位，降频验证。

### 0x75 完整实验 main

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "Serial.h"
#include "W25Q64.h"

uint8_t WBuf[8] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88};
uint8_t RBuf[8];
uint8_t MID;
uint16_t DID;

int main(void)
{
    Serial_Init();
    MySPI_HW_Init();
    W25Q64_Init();

    W25Q64_ReadID(&MID, &DID);
    printf("MID=0x%02X DID=0x%04X\r\n", MID, DID);

    W25Q64_SectorErase(0x000000);
    W25Q64_PageProgram(0x000000, WBuf, 8);
    W25Q64_ReadData(0x000000, RBuf, 8);

    for (uint8_t i = 0; i < 8; i++)
    {
        printf("%02X ", RBuf[i]);
    }
    printf("\r\n");

    if (W25Q64_Verify(0x000000, WBuf, 8))
    {
        printf("Verify OK\r\n");
    }
    else
    {
        printf("Verify FAIL\r\n");
    }

    while (1)
    {
    }
}
```

`W25Q64_Verify()` 可以用软件 SPI 篇里的实现，直接复用。

## 0x80 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| ID 读 0x00/0xFF | 接线、CS、供电 | 查 PA4/PA5/PA6/PA7、3.3 V |
| ID 对但读写错 | 模式/位序不对 | 试模式 0/3，MSB 先行 |
| 只能发不能收 | MISO 配成推挽/没接 | 改 `GPIO_Mode_IPU` |
| 数据整体移位 | CPOL/CPHA 错 | 对照从机手册 |
| 最后一个字节丢 | CS 拉高太早 | 等 BSY 清零 |
| 写不进去 | 没 WREN/没擦除 | 写使能 + 先擦后写 |
| 多从机冲突 | CS 同时有效 | 一次只选一个 |
| OVR 置位 | 只发不收，没读 DR | 每次交换都读 DR |
| MODF 置位 | NSS 冲突/硬件 NSS | 用软件 NSS |
| 速度上不去 | 分频太大/软件等待 | 改小分频、用 DMA |
| DMA 不搬 | 通道错/没开 DMAEN | SPI1_TX=Ch3、`SPI_I2S_DMACmd` |
| 重映射后无反应 | 没关 JTAG/没开 AFIO | 关 JTAG、开 AFIO、Remap |

### 0x81 硬件 CRC

SPI 外设自带 CRC 计算，用于通信校验：

```c
SPI_InitStructure.SPI_CRCPolynomial = 7;   /* 多项式 */
SPI_Init(SPI1, &SPI_InitStructure);

SPI_CalculateCRC(SPI1, ENABLE);            /* 开始计算 */
/* 发送/接收数据... */
uint16_t TxCRC = SPI_GetCRC(SPI1, SPI_CRC_Tx);
uint16_t RxCRC = SPI_GetCRC(SPI1, SPI_CRC_Rx);
SPI_CalculateCRC(SPI1, DISABLE);
```

W25Q64 不用 CRC（它用状态寄存器/ID 校验），普通 SPI 传感器也很少用；多机自定义协议可以用它省软件 CRC。

### 0x82 两片 STM32 主从通信

一片做主机、一片做从机：

```c
/* 从机 */
SPI_InitStructure.SPI_Mode = SPI_Mode_Slave;
SPI_InitStructure.SPI_NSS = SPI_NSS_Hard;   /* 用 NSS 引脚 */
```

接线：

```text
主机 SCK  ── 从机 SCK
主机 MOSI ── 从机 MOSI
主机 MISO ── 从机 MISO
主机 CS   ── 从机 NSS
共地
```

从机的 SCK 由主机提供，不需要自己配波特率；主机拉低 CS 才开始传输。调试时先确认两边模式一致。

### 0x83 常见 SPI 器件配置

| 器件 | 模式 | 最大时钟 | 备注 |
| ---- | ---- | -------- | ---- |
| W25Q64 | 0/3 | 80 MHz | 先发指令再读写 |
| OLED（SSD1306） | 0 | 10 MHz | DC 引脚区分命令/数据 |
| nRF24L01 | 0 | 10 MHz | CSN/CE 两根控制线 |
| MPU6500（SPI） | 0/3 | 10 MHz | 片选后先发读/写位 |
| MAX6675 | 0 | 5 MHz | 只读，16 位 |

配置前先看器件手册的“SPI timing”章节，确认模式、位序、最大时钟。

### 0x84 三个典型调试案例

**案例 1：ID 读 0xFF**

- 现象：MOSI 有波形，MISO 恒高；
- 排查：CS 有没有拉低？MISO 是否接到 PA6？从机 3.3 V 是否正常？
- 结论：CS 接到了 PA4 但代码里用的是 PB12，片选没生效。

**案例 2：写进去读回全 FF**

- 现象：`W25Q64_ReadData` 返回全 FF；
- 排查：写之前有没有 `0x06`？有没有擦除？BUSY 是否等完？
- 结论：漏了 `W25Q64_WriteEnable()`，WEL=0，编程命令被忽略。

**案例 3：偶发数据错位**

- 现象：大部分正确，偶尔整体移一位；
- 排查：时钟频率、线长、模式；
- 结论：SPI 时钟 18 MHz、杜邦线 20 cm，降到 4.5 MHz 后稳定。

调试顺序永远是：**先降速、再查线、最后查模式**。

### 0x85 用 SysTick 测吞吐

```c
uint32_t t0 = SysTick->VAL;
W25Q64_ReadData(0, Buf, 1024);
uint32_t t1 = SysTick->VAL;

/* SysTick 72MHz 向下计数，注意回绕 */
uint32_t cycles = (t0 > t1) ? (t0 - t1) : (t0 + 72000 - t1);
float us = cycles / 72.0f;
```

读 1 KB 的时间 × 8 就是实际 SPI 速率（含命令开销）。测出来远低于理论值，先查分频、DMA、CS 切换次数。

## 0x90 小结

| 项目 | 软件 SPI | 硬件 SPI |
| ---- | -------- | -------- |
| 引脚 | 任意 GPIO | 固定/重映射 |
| 速度 | 几百 kHz | 几 MHz ~ 18 MHz |
| CPU | 每位翻转 | 读写 DR + 等标志 |
| 代码 | 时序全手写 | 配 CR1/CR2 |
| 大批量 | 慢 | DMA |

### 思考题

1. 为什么发一个字节必须读一次 DR？
2. TXE 和 BSY 的区别是什么？拉 CS 前该等哪个？
3. 软件 NSS 和硬件 NSS 各适合什么场景？
4. SPI1 重映射到 PB3/PB4/PB5 为什么要先关 JTAG？
5. DMA 发送时，为什么最后还要等 BSY 才能拉高 CS？

硬件 SPI 的关键只有三件事：**模式配对、片选管好、DR 读写配对**。把这三件事做对，W25Q64、OLED、无线模块都能直接换上来。
