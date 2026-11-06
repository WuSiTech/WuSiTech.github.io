+++
title = "STM32 SPI：四线协议、四种模式与 W25Q64 读写"
date = "2026-11-04T19:30:00+08:00"
lastmod = "2026-11-06T23:59:00+08:00"
draft = false
description = "从 SPI 的四线全双工、移位寄存器、CPOL/CPHA 四种模式讲起，再吃透 W25Q64 的容量组织、指令集、状态寄存器、页写/扇区擦除/忙等待，给出软件 SPI + 完整 W25Q64 驱动（含跨页写、校验、测速）与 12 条故障排查。"
categories = [ "STM32" ]
tags = [ "STM32", "SPI", "W25Q64", "Flash" ]
cover = "/images/pool/covers/covers-13.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 11 章前半（11-1 ~ 11-3）。

代码基于 **STM32F103C8T6 + 标准外设库 3.5.0**，不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 11-1 | SPI 通信、硬件电路、移位示意图、时序基本单元（模式 0~3） | 0x00 ~ 0x20 |
| 11-2 | W25Q64 简介、容量/引脚/框图、指令表、状态寄存器、时序 | 0x30 |
| 11-3 | 软件 SPI 读写 W25Q64（代码） | 0x40 ~ 0x60 |

视频之外还补了：多从机片选、时钟频率与建立保持时间、页写跨页、数据校验、测速、ID/UID、12 条故障排查。

## 0x00 SPI 是什么

![SPI 总线与常见模块](/images/posts/stm32-spi/spi-intro.webp)

SPI（Serial Peripheral Interface）是 Motorola 开发的一种**同步、全双工**串行总线，四根线：

- **SCK**（Serial Clock）：时钟，由主机产生；
- **MOSI**（Master Output Slave Input）：主机发、从机收；
- **MISO**（Master Input Slave Output）：从机发、主机收；
- **SS**（Slave Select）：片选，低电平有效。

和 I2C 相比：SPI 没有地址、没有应答，靠**独立的片选线**选设备；速度快（几十 MHz）、协议简单，但引脚多。

| 项目 | SPI | I2C | UART |
| ---- | --- | --- | ---- |
| 线数 | 4 + 片选 | 2 | 2 |
| 双工 | 全双工 | 半双工 | 全双工 |
| 速率 | 几 MHz ~ 几十 MHz | 100/400 kHz | ≤1 Mbps |
| 寻址 | 片选 | 地址 | 无 |
| 多设备 | 片选数量 | 地址 | 点对点 |
| 应答 | 无 | 有 | 无 |

## 0x10 硬件连接

- 所有设备的 SCK、MOSI、MISO 并在一起；
- 主机另外引出多根 SS，分别接到每个从机的 SS；
- 主机输出脚（SCK、MOSI、SS）配**推挽输出**，MISO 配**浮空或上拉输入**；
- 同一时刻只拉低一个 SS，否则多个从机同时驱动 MISO，会打架。

### 0x11 多从机片选

```text
主机 SS1 ── 从机1 SS
主机 SS2 ── 从机2 SS
主机 SS3 ── 从机3 SS
```

从机数量 = 片选数量。也可以把多个从机“菊花链”（一个的 MISO 接下一个的 MOSI），但时序和协议更复杂，普通场景不用。

### 0x12 电平、上拉与串联电阻

- 3.3 V 与 5 V 器件混接时，用电平转换或确认引脚 5 V 容忍；
- MISO 是输入，主机端可加上拉，防止从机没选中时浮空；
- 长线、高速时在 SCK/MOSI 上串 22 ~ 100 Ω 电阻，抑制振铃；
- 线尽量短，SCK 和 MISO 分开走，避免串扰。

## 0x20 时序

### 0x21 移位原理

![SPI 移位示意图](/images/posts/stm32-spi/spi-shift.webp)

SPI 的本质是**两个移位寄存器首尾相接**：主机把一个字节移出去，同时从机把一个字节移进来，8 个时钟后两边交换完成。所以“发一个字节”和“收一个字节”是同一次操作。

- 主机发送：MOSI 逐位移出，SCK 打拍；
- 从机同时：MISO 逐位移出；
- 8 个时钟后，双方都拿到了对方的一个字节。

### 0x22 CPOL 与 CPHA

SPI 有四个模式，由两个参数决定：

- **CPOL**（Clock Polarity）：空闲时 SCK 是高还是低；
- **CPHA**（Clock Phase）：数据在第一个边沿还是第二个边沿采样。

| 模式 | CPOL | CPHA | 采样边沿 | 空闲电平 |
| ---- | ---- | ---- | -------- | -------- |
| 0 | 0 | 0 | 第 1 个（上升） | 低 |
| 1 | 0 | 1 | 第 2 个（下降） | 低 |
| 2 | 1 | 0 | 第 1 个（下降） | 高 |
| 3 | 1 | 1 | 第 2 个（上升） | 高 |

![SPI 模式 0 时序](/images/posts/stm32-spi/spi-mode.webp)

以模式 0 为例：SCK 空闲为低；第一个边沿（上升沿）双方**移入**数据，第二个边沿（下降沿）**移出**下一位。所以代码里通常是“先放好 MOSI，再拉高 SCK 采样，再拉低 SCK”。

### 0x23 模式选择

- 从机手册会写支持的模式，W25Q64 支持 **模式 0 和模式 3**；
- 主从必须一致，否则数据全错；
- 不确定时先试模式 0，再试模式 3；
- 逻辑分析仪解码时也要选对模式。

### 0x24 时钟频率与建立保持

- W25Q64 最高 80 MHz（不同型号 104 MHz），但软件 SPI 通常只到几百 kHz ~ 几 MHz；
- 从机的 `tSU`/`tH`（建立/保持时间）必须满足；
- 线太长、上拉太弱时，高速会振铃/过冲，先降频；
- SCK 的占空比一般 50%，模式 0/3 下高电平采样。

### 0x25 SPI 的几种变体

- **标准 SPI（4 线）**：SCK/MOSI/MISO/SS，全双工；
- **3 线 SPI**：MOSI 和 MISO 合并成一根双向线，半双工，省引脚；
- **Dual SPI**：MOSI/MISO 都变成双向数据线，一次传 2 位；
- **Quad SPI（QSPI）**：4 根数据线，一次传 4 位，速度快 4 倍。

W25Q64 支持标准/Dual/Quad 模式，普通课程只用标准 4 线；做高速字库/图片时可以用 QSPI 把吞吐拉上去。

### 0x26 多从机的片选切换

同一组 SCK/MOSI/MISO 挂多个从机时：

```c
void SPI_Select(uint8_t Dev)
{
    GPIO_SetBits(GPIOB, GPIO_Pin_12 | GPIO_Pin_8);   /* 全部拉高 */
    switch (Dev)
    {
        case 0: GPIO_ResetBits(GPIOB, GPIO_Pin_12); break;  /* 从机 0 */
        case 1: GPIO_ResetBits(GPIOB, GPIO_Pin_8);  break;  /* 从机 1 */
    }
}
```

要点：

- 切换前先拉高所有 CS，再拉低目标 CS；
- CS 拉低到第一个时钟之间要留 `tSLCH`（几 ns ~ 几十 ns）；
- 两个从机不能同时被选中，否则 MISO 冲突。

### 0x27 SPI 的中断与 DMA

软件 SPI 靠 CPU 逐位翻转；硬件 SPI 可以配中断或 DMA：

- **中断**：TXE 空中断写下一个字节，RXNE 接收中断读数据；
- **DMA**：`SPI1_TX = DMA1_Channel3`、`SPI1_RX = DMA1_Channel2`，一次性搬一整块；
- 刷屏、读 Flash 大块数据时，DMA 能把 CPU 占用降到接近 0。

硬件 SPI + DMA 的详细配置见下一篇《硬件 SPI》。

## 0x30 W25Q64

### 0x31 容量与组织

| 参数 | 值 |
| ---- | -- |
| 容量 | 64 Mbit = 8 MB |
| 地址 | 24 位（0x000000 ~ 0x7FFFFF） |
| 页 | 256 字节（共 32768 页） |
| 扇区 | 4 KB（共 2048 个） |
| 块 | 64 KB（共 128 个） |
| 电压 | 2.7 ~ 3.6 V |
| 接口 | SPI 模式 0/3，最高 80 MHz |

### 0x32 引脚

| 引脚 | 作用 |
| ---- | ---- |
| CS | 片选，低有效 |
| CLK | 时钟 |
| DI（MOSI） | 数据输入 |
| DO（MISO） | 数据输出 |
| WP | 写保护，低有效（可接 VCC 关闭） |
| HOLD | 保持，低有效（可接 VCC） |
| VCC/GND | 电源 |

模块上一般把 WP/HOLD 上拉，只引出 CS/CLK/DI/DO/VCC/GND。

### 0x33 指令表

| 指令 | 代码 | 作用 |
| ---- | ---- | ---- |
| Write Enable | 0x06 | 写使能（WEL=1） |
| Write Disable | 0x04 | 写禁止 |
| Read Status 1 | 0x05 | 读状态（BUSY/WEL/BP） |
| Read Status 2 | 0x35 | 读状态 2 |
| Write Status | 0x01 | 写状态 |
| Read Data | 0x03 | 读数据（24 位地址） |
| Fast Read | 0x0B | 快速读（加 dummy） |
| Page Program | 0x02 | 页编程（≤256 B） |
| Sector Erase | 0x20 | 4 KB 擦除 |
| Block Erase | 0xD8 | 64 KB 擦除 |
| Chip Erase | 0xC7 | 整片擦除 |
| JEDEC ID | 0x9F | 厂商 + 容量 ID |
| Read UID | 0x4B | 64 位唯一 ID |

### 0x34 状态寄存器

状态寄存器 1（0x05 读）：

| 位 | 名称 | 含义 |
| -- | ---- | ---- |
| 0 | BUSY | 1 = 正在擦/写 |
| 1 | WEL | 1 = 写使能 |
| 2~4 | BP0~BP2 | 块保护 |
| 5 | TB | 保护范围从顶还是底 |
| 6 | SEC | 保护粒度（4KB/64KB） |
| 7 | SRP | 状态寄存器保护 |

写/擦之前必须先 `0x06` 让 WEL=1；写/擦期间 BUSY=1，必须等它清零。

### 0x35 读/写/擦时序

**读**：

```text
CS↓ | 0x03 | 地址 24 位 | 数据 0 | 数据 1 | ... | CS↑
```

地址自动递增，没有长度限制，可以一直读到末尾（回卷）。

**页写**：

```text
CS↓ | 0x06（写使能，先单独发）| CS↑
CS↓ | 0x02 | 地址 24 位 | 数据 0..N | CS↑
等 BUSY=0
```

一页最多 256 字节；超过页边界会**回卷到页首覆盖**，所以跨页要分段写。

**扇区擦除**：

```text
CS↓ | 0x06 | CS↑
CS↓ | 0x20 | 地址 24 位 | CS↑
等 BUSY=0（约 45 ms）
```

### 0x36 ID 与 UID

- JEDEC ID（0x9F）：厂商 0xEF（Winbond）+ 容量 0x4017（W25Q64）；
- UID（0x4B）：64 位唯一 ID，可做设备序列号。

读到 `0xEF 0x40 0x17` 说明接线和时序都对。

### 0x37 存储阵列与地址计算

W25Q64 的 8 MB 地址空间是线性的，但内部按“页/扇区/块”管理：

```text
地址 0x000000 ─┬─ 页 0（256B）── 扇区 0（4KB）── 块 0（64KB）
               ├─ 页 1
               ...
地址 0x7FFFFF ─┴─ 最后一页
```

地址换算：

```text
页号   = Address / 256
页内偏移 = Address % 256
扇区号 = Address / 4096
块号   = Address / 65536
```

写之前要知道“这一页是不是空的”。如果页内有旧数据，必须先擦整个扇区（4 KB），不能只擦一个字节。

### 0x38 SFDP 与兼容型号

W25Q64 支持 **SFDP**（0x5A）读参数表，操作系统/驱动可以自动识别容量、擦除粒度、时序。自己写驱动一般不用，但换型号（W25Q32/128）时，JEDEC ID 的容量字节会变：

| 型号 | 容量 | JEDEC ID |
| ---- | ---- | -------- |
| W25Q32 | 4 MB | 0xEF4016 |
| W25Q64 | 8 MB | 0xEF4017 |
| W25Q128 | 16 MB | 0xEF4018 |

驱动里最好根据 ID 计算容量，而不是写死 0x7FFFFF。

### 0x39 内部结构与写缓冲

W25Q64 内部大致是：

```text
SPI 接口 → 命令解码 → 地址锁存 → 存储阵列（8 MB）
                     ↘ 256B 页缓冲 → 编程/擦除控制 → 状态寄存器
```

- 页编程先把数据收进 256 B 页缓冲，再一次性写进阵列；
- 擦除是“按扇区/块”把整片区域置 0xFF；
- 写保护（WP/BP）可以锁住部分区域，防止误写；
- 状态寄存器的 BUSY 反映内部操作是否完成。

理解“页缓冲”就能理解为什么页写不能跨页：缓冲只有 256 B，地址在页内回卷。

## 0x40 软件 SPI

### 0x41 引脚与初始化

`MySPI.h`：

```c
#ifndef __MYSPI_H
#define __MYSPI_H

#include "stm32f10x.h"

void MySPI_Init(void);
void MySPI_Start(void);
void MySPI_Stop(void);
uint8_t MySPI_SwapByte(uint8_t ByteSend);

#endif
```

`MySPI.c`：

```c
#include "MySPI.h"
#include "Delay.h"

/* PB12=SS，PB13=SCK，PB14=MISO，PB15=MOSI */
void MySPI_W_SS(uint8_t BitValue)
{
    GPIO_WriteBit(GPIOB, GPIO_Pin_12, (BitAction)BitValue);
}

void MySPI_W_SCK(uint8_t BitValue)
{
    GPIO_WriteBit(GPIOB, GPIO_Pin_13, (BitAction)BitValue);
}

void MySPI_W_MOSI(uint8_t BitValue)
{
    GPIO_WriteBit(GPIOB, GPIO_Pin_15, (BitAction)BitValue);
}

uint8_t MySPI_R_MISO(void)
{
    return GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_14);
}

void MySPI_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_12 | GPIO_Pin_13 | GPIO_Pin_15;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOB, &GPIO_InitStructure);

    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_14;
    GPIO_Init(GPIOB, &GPIO_InitStructure);

    MySPI_W_SS(1);
    MySPI_W_SCK(0);   /* 模式 0：空闲低 */
}

void MySPI_Start(void) { MySPI_W_SS(0); }
void MySPI_Stop(void)  { MySPI_W_SS(1); }
```

### 0x42 交换一个字节

```c
uint8_t MySPI_SwapByte(uint8_t ByteSend)
{
    uint8_t ByteReceive = 0x00;

    for (uint8_t i = 0; i < 8; i++)
    {
        MySPI_W_MOSI(ByteSend & (0x80 >> i));  /* 高位先行 */
        MySPI_W_SCK(1);                        /* 上升沿采样 */
        if (MySPI_R_MISO() == 1)
        {
            ByteReceive |= (0x80 >> i);
        }
        MySPI_W_SCK(0);                        /* 下降沿准备下一位 */
    }

    return ByteReceive;
}
```

模式 3 只需把空闲电平反过来（SCK 空闲高，下降沿采样、上升沿移出），代码顺序相应调整。

### 0x43 速度优化

- `GPIO_WriteBit` 换成 `GPIOB->BSRR/BRR`；
- 去掉 `Delay_us`，用 `__NOP()` 控制半周期；
- 开 `-O2`；
- 逻辑分析仪确认从机能跟上再提速。

软件 SPI 通常能到 1 ~ 5 MHz（F103 @72 MHz）。

### 0x44 四种模式的代码差异

模式 0（CPOL=0，CPHA=0）：空闲低，上升沿采样、下降沿移出。

```c
uint8_t SPI_SwapMode0(uint8_t ByteSend)
{
    uint8_t ByteReceive = 0;

    for (uint8_t i = 0; i < 8; i++)
    {
        MySPI_W_MOSI(ByteSend & (0x80 >> i));
        MySPI_W_SCK(1);                       /* 第 1 边沿：采样 */
        if (MySPI_R_MISO()) ByteReceive |= (0x80 >> i);
        MySPI_W_SCK(0);                       /* 第 2 边沿：移出 */
    }

    return ByteReceive;
}
```

模式 3（CPOL=1，CPHA=1）：空闲高，上升沿采样、下降沿移出。

```c
uint8_t SPI_SwapMode3(uint8_t ByteSend)
{
    uint8_t ByteReceive = 0;

    for (uint8_t i = 0; i < 8; i++)
    {
        MySPI_W_SCK(0);                       /* 第 1 边沿：移出 */
        MySPI_W_MOSI(ByteSend & (0x80 >> i));
        MySPI_W_SCK(1);                       /* 第 2 边沿：采样 */
        if (MySPI_R_MISO()) ByteReceive |= (0x80 >> i);
    }

    return ByteReceive;
}
```

模式 1/2 只是把“采样”和“移出”的边沿对调：

| 模式 | 空闲 | 第 1 边沿 | 第 2 边沿 |
| ---- | ---- | --------- | --------- |
| 0 | 低 | 采样（上升） | 移出（下降） |
| 1 | 低 | 移出（上升） | 采样（下降） |
| 2 | 高 | 采样（下降） | 移出（上升） |
| 3 | 高 | 移出（下降） | 采样（上升） |

看不清时，先用逻辑分析仪抓从机的时序图，对照表选模式。

### 0x45 用 BSRR 直接操作提速

`GPIO_WriteBit` 内部有分支和参数检查，软件 SPI 里调用 8 次/字节，开销明显。直接写寄存器：

```c
#define SCK_H()  (GPIOB->BSRR = GPIO_Pin_13)
#define SCK_L()  (GPIOB->BRR  = GPIO_Pin_13)
#define MOSI_H() (GPIOB->BSRR = GPIO_Pin_15)
#define MOSI_L() (GPIOB->BRR  = GPIO_Pin_15)
#define MISO()   ((GPIOB->IDR & GPIO_Pin_14) != 0)
```

配合 `-O2`，软件 SPI 能从几百 kHz 提到 2 ~ 3 MHz。再快就要用硬件 SPI。

## 0x50 W25Q64 驱动

### 0x51 头文件

```c
#ifndef __W25Q64_H
#define __W25Q64_H

#include "stm32f10x.h"

void W25Q64_Init(void);
void W25Q64_ReadID(uint8_t *MID, uint16_t *DID);
void W25Q64_WriteEnable(void);
void W25Q64_WaitBusy(void);
void W25Q64_ReadData(uint32_t Address, uint8_t *Buffer, uint32_t Count);
void W25Q64_PageProgram(uint32_t Address, uint8_t *Buffer, uint16_t Count);
void W25Q64_SectorErase(uint32_t Address);
void W25Q64_BlockErase(uint32_t Address);
void W25Q64_ChipErase(void);
void W25Q64_Write(uint32_t Address, uint8_t *Buffer, uint32_t Count);

#endif
```

### 0x52 读 ID

```c
void W25Q64_ReadID(uint8_t *MID, uint16_t *DID)
{
    MySPI_Start();
    MySPI_SwapByte(0x9F);
    *MID = MySPI_SwapByte(0xFF);
    *DID = MySPI_SwapByte(0xFF);
    *DID <<= 8;
    *DID |= MySPI_SwapByte(0xFF);
    MySPI_Stop();
}
```

### 0x53 写使能与忙等待

```c
void W25Q64_WriteEnable(void)
{
    MySPI_Start();
    MySPI_SwapByte(0x06);
    MySPI_Stop();
}

void W25Q64_WaitBusy(void)
{
    uint8_t Status;

    MySPI_Start();
    MySPI_SwapByte(0x05);
    do
    {
        Status = MySPI_SwapByte(0xFF);
    } while (Status & 0x01);
    MySPI_Stop();
}
```

### 0x54 读数据

```c
void W25Q64_ReadData(uint32_t Address, uint8_t *Buffer, uint32_t Count)
{
    MySPI_Start();
    MySPI_SwapByte(0x03);
    MySPI_SwapByte(Address >> 16);
    MySPI_SwapByte(Address >> 8);
    MySPI_SwapByte(Address);

    for (uint32_t i = 0; i < Count; i++)
    {
        Buffer[i] = MySPI_SwapByte(0xFF);
    }

    MySPI_Stop();
}
```

### 0x55 页编程

```c
void W25Q64_PageProgram(uint32_t Address, uint8_t *Buffer, uint16_t Count)
{
    if (Count > 256) Count = 256;

    W25Q64_WriteEnable();

    MySPI_Start();
    MySPI_SwapByte(0x02);
    MySPI_SwapByte(Address >> 16);
    MySPI_SwapByte(Address >> 8);
    MySPI_SwapByte(Address);

    for (uint16_t i = 0; i < Count; i++)
    {
        MySPI_SwapByte(Buffer[i]);
    }

    MySPI_Stop();
    W25Q64_WaitBusy();
}
```

### 0x56 擦除

```c
void W25Q64_SectorErase(uint32_t Address)
{
    W25Q64_WriteEnable();

    MySPI_Start();
    MySPI_SwapByte(0x20);
    MySPI_SwapByte(Address >> 16);
    MySPI_SwapByte(Address >> 8);
    MySPI_SwapByte(Address);
    MySPI_Stop();

    W25Q64_WaitBusy();
}

void W25Q64_BlockErase(uint32_t Address)
{
    W25Q64_WriteEnable();

    MySPI_Start();
    MySPI_SwapByte(0xD8);
    MySPI_SwapByte(Address >> 16);
    MySPI_SwapByte(Address >> 8);
    MySPI_SwapByte(Address);
    MySPI_Stop();

    W25Q64_WaitBusy();
}

void W25Q64_ChipErase(void)
{
    W25Q64_WriteEnable();

    MySPI_Start();
    MySPI_SwapByte(0xC7);
    MySPI_Stop();

    W25Q64_WaitBusy();
}
```

### 0x57 跨页写

页写不能跨页，封一个“自动分段”的函数：

```c
void W25Q64_Write(uint32_t Address, uint8_t *Buffer, uint32_t Count)
{
    while (Count)
    {
        uint16_t PageRemain = 256 - (Address % 256);
        uint16_t Len = (Count < PageRemain) ? Count : PageRemain;

        W25Q64_PageProgram(Address, Buffer, Len);

        Address += Len;
        Buffer += Len;
        Count -= Len;
    }
}
```

### 0x58 写入校验

写完读回来比对，避免“写进去了但位没翻”：

```c
uint8_t W25Q64_Verify(uint32_t Address, uint8_t *Buffer, uint32_t Count)
{
    uint8_t Temp[32];

    while (Count)
    {
        uint16_t Len = (Count < sizeof(Temp)) ? Count : sizeof(Temp);
        W25Q64_ReadData(Address, Temp, Len);
        for (uint16_t i = 0; i < Len; i++)
        {
            if (Temp[i] != Buffer[i]) return 0;
        }
        Address += Len;
        Buffer += Len;
        Count -= Len;
    }

    return 1;
}
```

### 0x59 擦除策略与寿命

- 擦除以扇区（4 KB）为单位，写之前要擦整个扇区；
- 擦除寿命约 **10 万次**，写入寿命更长，但每次改一个参数都“擦 4 KB”很浪费；
- 参数存储常用“**双扇区轮换**”：A 扇区写满后切到 B，B 写满再回 A，寿命翻倍；
- 或者加一层“日志式”追加写，只在扇区满时擦一次。

```c
/* 双扇区轮换的简化逻辑 */
uint32_t Param_Write(uint8_t *Data, uint16_t Len)
{
    static uint8_t CurSector = 0;
    uint32_t Addr = CurSector ? 0x001000 : 0x000000;

    W25Q64_SectorErase(Addr);
    W25Q64_Write(Addr, Data, Len);

    CurSector ^= 1;
    return Addr;
}
```

### 0x5A 掉电保护

写 Flash 时掉电，可能只写了一部分。可靠做法：

1. 先写数据到 A 区，校验通过；
2. 再写“有效标志”到 B 区；
3. 上电时优先读 B 区标志，只有标志有效才用 A 区数据；
4. 标志也带 CRC。

这样最坏情况是“新数据没写完”，但旧数据还在，不会把参数写坏。

## 0x60 实验与调试

### 0x61 读 ID

```c
uint8_t MID;
uint16_t DID;

W25Q64_Init();
W25Q64_ReadID(&MID, &DID);
printf("MID=0x%02X DID=0x%04X\r\n", MID, DID);
```

预期 `MID=0xEF`、`DID=0x4017`。不对就查接线/模式/片选。

### 0x62 读写擦除

```c
uint8_t WBuf[4] = {0x12, 0x34, 0x56, 0x78};
uint8_t RBuf[4];

W25Q64_SectorErase(0x000000);
W25Q64_Write(0x000000, WBuf, 4);
W25Q64_ReadData(0x000000, RBuf, 4);
```

现象：擦除后读全 `0xFF`；写后读 `12 34 56 78`；不擦除直接改写，新数据会和旧数据“按位与”。

### 0x63 逻辑分析仪

抓一次“读 ID”：

```text
CS↓ | 9F | EF | 40 | 17 | CS↑
```

如果 MOSI 上有数据但 MISO 全 FF：查 MISO 接线、片选、从机供电。

### 0x64 测速

用 SysTick 计时 1 KB 读/写：

```c
uint32_t t0 = SysTick->VAL;
W25Q64_ReadData(0, Buf, 1024);
uint32_t t1 = SysTick->VAL;
```

软件 SPI 读 1 KB 通常几十 ms；页写还要加 0.7 ms/页 + 擦除时间。测速能直观看到“软件 SPI 慢在哪”。

### 0x65 完整实验 main

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "Serial.h"
#include "W25Q64.h"

uint8_t WBuf[8] = {0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08};
uint8_t RBuf[8];
uint8_t MID;
uint16_t DID;

int main(void)
{
    Serial_Init();
    W25Q64_Init();

    W25Q64_ReadID(&MID, &DID);
    printf("MID=0x%02X DID=0x%04X\r\n", MID, DID);

    W25Q64_SectorErase(0x000000);
    W25Q64_Write(0x000000, WBuf, 8);
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

### 0x66 用 W25Q64 存字库/图片

W25Q64 常用来存：

- 汉字点阵字库（GB2312 每字 32 字节）；
- 图片/图标（RGB565）；
- 音频片段；
- 升级固件备份。

以 16×16 汉字为例，字模 32 字节，按“区位码”算地址：

```text
offset = ((区码 - 1) * 94 + (位码 - 1)) * 32
```

取字模：

```c
void Font_Read(uint8_t Qu, uint8_t Wei, uint8_t *Buf)
{
    uint32_t Offset = ((Qu - 1) * 94 + (Wei - 1)) * 32;
    W25Q64_ReadData(Offset, Buf, 32);
}
```

图片则按“宽 × 高 × 2 字节”顺序读，直接送 LCD。

### 0x67 SPI Flash 与 MCU Flash、EEPROM 对比

| 项目 | W25Q64 | STM32 内部 Flash | AT24C02 |
| ---- | ------ | ---------------- | ------- |
| 容量 | 8 MB | 64 KB | 256 B |
| 接口 | SPI | 内部总线 | I2C |
| 擦除粒度 | 4 KB | 1 KB | 页/整片 |
| 写入粒度 | 256 B 页 | 16 位半字 | 1 B |
| 寿命 | 10 万次 | 1 万次 | 100 万次 |
| 速度 | 几 MB/s | 几十 KB/s | 几十 KB/s |
| 适合 | 字库、图片、日志 | 参数、小数据 | 少量参数 |

选型口诀：**少量参数用 EEPROM，中等数据用内部 Flash，大文件用 SPI Flash**。

### 0x68 用 W25Q64 做数据日志

日志的典型设计：

```text
扇区头：magic + 版本 + 写指针 + CRC
记录区：时间戳 + 长度 + 数据 + CRC
```

写入时追加到写指针，指针到达扇区尾就切到下一个扇区；全部写满再回头擦最旧的扇区（环形日志）。这样既不会频繁擦除，也能保留最近 N 条记录。

读取时从写指针往前找最后一条有效记录，校验 CRC 通过才算数。

## 0x70 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| ID 读 0x00/0xFF | 接线、片选、供电 | 查 CS/CLK/DI/DO、3.3 V |
| ID 对但读写错 | 模式/位序不对 | 试模式 0/3，确认 MSB 先行 |
| 写不进去 | 没发 0x06、没擦除 | 写使能 + 先擦后写 |
| 写一半丢 | 跨页 | 用 `W25Q64_Write` 分段 |
| 擦除后仍读旧值 | 没等 BUSY | 等 BUSY 清零再读 |
| 数据偶尔错 | 时钟太快/线太长 | 降频、缩短线、串联电阻 |
| MISO 一直高 | 片选没拉低/从机没选 | 查 CS |
| 多个从机冲突 | 同时拉低多个 CS | 一次只选一个 |
| 整片擦除很久 | 正常（几十秒） | 用扇区/块擦除替代 |
| 写入次数有限 | Flash 寿命约 10 万次 | 加磨损均衡/缓存 |
| 读回校验失败 | 写保护/电压不稳 | 查 WP 引脚、电源 |
| 掉电丢数据 | 写周期没完成 | 写完等 BUSY，再加掉电检测 |

### 0x71 SPI 时序参数

W25Q64 数据手册里的关键参数：

| 参数 | 含义 | 典型值 |
| ---- | ---- | ------ |
| fR | 时钟频率 | 80 MHz |
| tCLH/tCLL | 时钟高/低时间 | 4 ns |
| tSLCH | CS 下降到第一个时钟 | 5 ns |
| tCHSH | 最后一个时钟到 CS 上升 | 5 ns |
| tSHSL | CS 高电平最小宽度 | 50 ns |
| tSHQZ | CS 上升到输出高阻 | 6 ns |

软件 SPI 通常远低于这些上限，但“CS 拉高太早”仍会截断最后一个字节，所以发完要等一个字节时间再拉 CS。

### 0x72 逻辑分析仪解码

- 采样率至少 4 倍于 SCK；
- 协议选 SPI，配置 CPOL/CPHA、位序、CS 极性；
- 先抓“读 ID”，确认 `9F EF 40 17`；
- 再抓“页写”，确认 `02 + 地址 + 数据`；
- 如果 MOSI 对、MISO 全 FF，重点查 MISO/CS/供电。

### 0x73 实战：参数存储模块

把“magic + 版本 + 长度 + 数据 + CRC”封装成一个参数块：

```c
#define PARAM_ADDR 0x000000

typedef struct
{
    uint32_t Magic;        /* 0x55AA1234 */
    uint16_t Version;
    uint16_t Length;
    uint8_t  Data[64];
    uint16_t Crc;
} ParamBlock;

uint16_t Param_CRC16(uint8_t *Buf, uint16_t Len)
{
    uint16_t Crc = 0xFFFF;

    for (uint16_t i = 0; i < Len; i++)
    {
        Crc ^= Buf[i];
        for (uint8_t j = 0; j < 8; j++)
        {
            Crc = (Crc & 1) ? (Crc >> 1) ^ 0xA001 : (Crc >> 1);
        }
    }

    return Crc;
}

uint8_t Param_Save(ParamBlock *Param)
{
    Param->Magic = 0x55AA1234;
    Param->Version = 1;
    Param->Length = sizeof(Param->Data);
    Param->Crc = Param_CRC16((uint8_t *)Param, sizeof(ParamBlock) - 2);

    W25Q64_SectorErase(PARAM_ADDR);
    W25Q64_Write(PARAM_ADDR, (uint8_t *)Param, sizeof(ParamBlock));

    return W25Q64_Verify(PARAM_ADDR, (uint8_t *)Param, sizeof(ParamBlock));
}

uint8_t Param_Load(ParamBlock *Param)
{
    W25Q64_ReadData(PARAM_ADDR, (uint8_t *)Param, sizeof(ParamBlock));

    if (Param->Magic != 0x55AA1234) return 0;

    uint16_t Crc = Param_CRC16((uint8_t *)Param, sizeof(ParamBlock) - 2);
    return Crc == Param->Crc;
}
```

上电时 `Param_Load()` 失败就用默认值，保存时先擦后写再校验。参数结构体加了版本号，以后加字段可以兼容旧数据。

### 0x74 常见波形问题

| 波形现象 | 可能原因 | 处理 |
| -------- | -------- | ---- |
| CS 上有毛刺 | GPIO 初始化顺序/上电抖动 | 先拉高再配输出，加 10k 上拉 |
| SCK 振铃/过冲 | 线长、阻抗不匹配 | 串 22~100Ω、缩短线 |
| MISO 一直高 | 从机没选中/没供电 | 查 CS、VCC |
| MISO 中间塌陷 | 总线冲突/两个 CS 同时低 | 一次只选一个 |
| 数据整体移位一位 | 模式/边沿错 | 换 CPOL/CPHA |
| 最后一个字节错 | CS 拉高太早 | 等一个字节时间再拉 CS |

示波器看 SCK 时，探头地线要短；否则看到的“振铃”其实是探头引入的。

## 0x80 小结

| 主题 | 要点 |
| ---- | ---- |
| 线序 | SCK/MOSI/MISO/SS，主机推挽、MISO 输入 |
| 模式 | CPOL/CPHA 四种，主从必须一致 |
| 全双工 | 交换一个字节 = 同时发和收 |
| W25Q64 | 8 MB、24 位地址、页 256B、扇区 4KB |
| 写流程 | WREN → 擦除/编程 → 等 BUSY |
| 读流程 | 0x03 + 24 位地址 + 连续读 |
| 跨页 | 按 256 字节分段 |

### 思考题

1. SPI 为什么不需要“地址”？
2. 模式 0 和模式 3 的区别是什么？为什么 W25Q64 两种都支持？
3. 页写跨越 256 字节边界会发生什么？
4. 为什么写之前必须先擦除？
5. 软件 SPI 提速有哪些办法？瓶颈在哪？

SPI 的代码比 I2C 短，是因为它把“地址、应答、仲裁”都省掉了，换成了一根片选线。理解“移位寄存器交换”这一点，四种模式和全双工就都通了。
