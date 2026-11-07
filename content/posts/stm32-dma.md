+++
title = "STM32 DMA：从存储器映射到多通道采集与双缓冲"
date = "2026-10-31T19:30:00+08:00"
lastmod = "2026-11-06T23:45:00+08:00"
draft = false
description = "以 STM32F103C8T6 与标准外设库为例，讲透 DMA 的存储器映射、通道请求、方向/宽度/自增、仲裁与循环模式，给出 M2M、ADC 多通道、USART 发送、半传输双缓冲四套完整 .h/.c/main.c 代码，并附调试与性能对比方法。"
categories = [ "STM32" ]
tags = [ "STM32", "DMA", "ADC", "USART" ]
cover = "/images/pool/covers/covers-08.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 8 章（8-1、8-2）。

代码基于 **STM32F103C8T6 + STM32F10x 标准外设库 3.5.0**（API 已按 STM32F10x StdPeriph 3.5 头文件核对；Delay/OLED/Key 为课程配套驱动），不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 8-1 | DMA 简介、存储器映像、DMA 框图、基本结构、DMA 请求、数据转运、ADC 扫描 + DMA | 0x00 ~ 0x30 |
| 8-2 | 数据转运、DMA + AD 多通道（代码） | 0x41、0x42 |

视频之外还补了：通道映射全表、带宽估算、数据一致性、USART 发送 DMA、半传输双缓冲、定时器触发采集、10 条故障排查。

## 0x00 为什么需要 DMA

先算一笔账。用 CPU 轮询搬数据，每搬一个 16 位数据大约要：

```text
读外设寄存器 → 写内存 → 判断标志 → 循环
```

按 10 条指令、72 MHz、平均 2 周期/指令估算，一个数据约 0.28 µs，也就是 CPU 最多每秒搬 350 万个点。听起来不少，但：

- ADC 四通道、每通道 10 kHz，就是 4 万点/秒；
- 串口 115200 波特率，满速约 11.5 KB/s；
- 一块 SPI 屏刷一帧 320×240×2 B = 150 KB，按 10 MHz SPI 约 15 ms，CPU 如果一边搬一边算，帧率立刻掉。

这些“搬砖”活不需要运算，却占着 CPU 和总线。DMA（Direct Memory Access）就是把这些活接过去：**外设和存储器之间、存储器和存储器之间，由 DMA 控制器直接搬，CPU 只配置和收尾**。

STM32F103 的 DMA 资源：

| 控制器 | 通道数 | 挂载总线 | 说明 |
| ------ | ------ | -------- | ---- |
| DMA1 | 7 | AHB | 外设请求为主，也支持 M2M |
| DMA2 | 5 | AHB | 仅部分型号（F103 大容量/互联型） |

C8T6 只有 **DMA1，7 个通道**。

## 0x10 存储器映射与总线

![STM32 存储器映像](/images/posts/stm32-dma/dma-map.webp)

Cortex-M3 把 Flash、SRAM、外设寄存器**统一编址**到 4 GB 空间：

| 类型 | 起始地址 | 大小（C8T6） | 用途 |
| ---- | -------- | ------------ | ---- |
| 程序 Flash | 0x0800 0000 | 64 KB | 代码、常量 |
| 系统存储器 | 0x1FFF F000 | 2 KB | 出厂 BootLoader |
| 选项字节 | 0x1FFF F800 | 16 B | 读/写保护 |
| SRAM | 0x2000 0000 | 20 KB | 变量、栈、缓冲区 |
| 外设寄存器 | 0x4000 0000 | — | ADC、USART、TIM… |
| 内核外设 | 0xE000 0000 | — | NVIC、SysTick、SCB |

所以“把 ADC 的 DR 搬到数组”在 DMA 眼里就是“从地址 A 搬到地址 B”，和“把数组 A 搬到数组 B”没有本质区别。区别只在**谁发请求**：外设搬数据靠硬件请求，内存搬内存靠软件触发。

DMA 挂在 **AHB 总线**上，通过总线矩阵访问 Flash、SRAM 和 AHB/APB 外设。CPU 和 DMA 同时访问同一条总线时由仲裁器决定先后，所以 DMA 搬运时 CPU 还能跑，只是访存会稍慢。

## 0x20 DMA 控制器

![DMA 在总线上的位置](/images/posts/stm32-dma/dma-block.webp)

DMA 控制器为每个通道维护一组寄存器：

- **CPAR**（外设地址）：源或目的的外设寄存器地址；
- **CMAR**（存储器地址）：源或目的的内存缓冲区地址；
- **CNDTR**（传输计数器）：还要搬多少个数据；
- **CCR**（配置）：方向、宽度、自增、循环、优先级、中断、使能。

通道收到请求后，按配置做一次“读—写”，然后 CNDTR 减 1；减到 0 时置 TC 标志，循环模式下自动重装。

![DMA 基本结构](/images/posts/stm32-dma/dma-basic.webp)

一个通道的配置要素：

| 配置 | 含义 | 常见取值 |
| ---- | ---- | -------- |
| 外设地址 | `&ADC1->DR`、`&USART1->DR` | 固定 |
| 存储器地址 | 数组/缓冲区 | 自增 |
| 方向 | P2M / M2P / M2M | 看场景 |
| 数据宽度 | 字节/半字/字 | 匹配外设 |
| 地址自增 | 外设一般不自增，内存一般自增 | |
| 传输计数 | 16 位，1 ~ 65535 | |
| 循环模式 | 到 0 是否自动重装 | ADC 连续采样 |
| 优先级 | 4 档 | |
| 触发 | 软件/硬件 | M2M 只能软件 |

### 0x21 通道与请求

![DMA1 请求映像](/images/posts/stm32-dma/dma-request.webp)

每个通道的硬件请求源是**芯片设计死的**，不能随便映射。F103 DMA1 的完整对应关系：

| 通道 | 请求源 |
| ---- | ------ |
| Ch1 | ADC1、TIM2_CH3、TIM4_CH1 |
| Ch2 | SPI1_RX、USART3_TX、TIM1_CH1、TIM2_UP、TIM3_CH3 |
| Ch3 | SPI1_TX、USART3_RX、TIM1_CH2、TIM3_CH4、TIM3_UP |
| Ch4 | SPI2_RX、USART1_TX、I2C2_TX、TIM1_CH4、TIM1_TRIG、TIM1_COM、TIM4_CH2 |
| Ch5 | SPI2_TX、USART1_RX、I2C2_RX、TIM1_UP、TIM2_CH1、TIM4_CH3 |
| Ch6 | USART2_RX、I2C1_TX、TIM1_CH3、TIM3_CH1、TIM3_TRIG |
| Ch7 | USART2_TX、I2C1_RX、TIM2_CH2、TIM2_CH4、TIM4_UP |

所以“ADC1 用 DMA1_Channel1”“USART1_TX 用 DMA1_Channel4”不是选择，是规定。选错通道，请求永远等不到，DMA 看起来“没反应”。

**触发方式**：

- **软件触发**：置 `CCR.EN` 后立即开始搬，适合 M2M；
- **硬件触发**：外设产生请求（ADC 的 EOC、USART 的 TXE）才搬一个。

M2M 模式只能用软件触发，因为“存储器”本身不会发请求。

### 0x22 方向、宽度与自增

**方向**：

| 宏 | 方向 | 场景 |
| -- | ---- | ---- |
| `DMA_DIR_PeripheralSRC` | 外设 → 存储器 | ADC、USART_RX、SPI_RX |
| `DMA_DIR_PeripheralDST` | 存储器 → 外设 | USART_TX、SPI_TX、DAC |
| `DMA_M2M_Enable` | 存储器 → 存储器 | 数组搬运、内存填充 |

**数据宽度**必须匹配：

- ADC 的 DR 是 16 位 → `DMA_PeripheralDataSize_HalfWord`；
- USART 的 DR 是 8 位 → `DMA_PeripheralDataSize_Byte`；
- 宽度写错不会报错，但数据会错位。比如按字（32 位）搬 16 位寄存器，会把相邻寄存器的值一起读进来。

**地址自增**：

- 外设寄存器地址固定 → `DMA_PeripheralInc_Disable`；
- 内存缓冲区要逐个写 → `DMA_MemoryInc_Enable`；
- 两个都自增或都不自增，都会导致数据全堆在一个地址或全读同一个值。

### 0x23 仲裁与优先级

多个通道同时请求时，DMA 按优先级仲裁：

1. **软件优先级**：VeryHigh > High > Medium > Low；
2. 同优先级时，**通道号越小越优先**（Ch1 > Ch2 …）。

高优先级通道可以插队，但不会打断“一个数据项的读-写”过程；所以即使低优先级通道正在搬，高优先级也要等当前这一个数据搬完。

### 0x24 计数器、循环与双缓冲

- **CNDTR 是 16 位**，一次最多 65535 个数据；
- **CNDTR = 0 时不会传输**，而且 `DMA_SetCurrDataCounter` 只能在通道关闭时写；
- **Normal**：减到 0 停止，需要重新使能；
- **Circular**：减到 0 自动重装，适合 ADC 连续采样、串口持续接收。

F103 的 DMA 没有硬件双缓冲（DMA2 的部分型号有），但可以用**半传输中断（HT）+ 两个缓冲区**做软件双缓冲：

```text
Buffer[0..N-1] 前半，Buffer[N..2N-1] 后半
HT 中断：前半满，处理前半
TC 中断：后半满，处理后半
```

这样 CPU 处理一块时，DMA 正在写另一块，互不干扰。

### 0x25 中断与标志

每个通道有 3 个常用标志：

| 标志 | 含义 | 用途 |
| ---- | ---- | ---- |
| TC | 传输完成 | 一帧收完/发完 |
| HT | 传输一半 | 双缓冲切换 |
| TE | 传输错误 | 总线错误、地址非法 |

清除标志要用 `DMA_ClearFlag()`，且**先读 ISR 再清**（硬件要求）；标准库已经处理。

### 0x26 寄存器

| 寄存器 | 作用 | 关键位 |
| ------ | ---- | ------ |
| `DMA_CCR1~7` | 通道配置 | EN、DIR、CIRC、PINC、MINC、PSIZE、MSIZE、PL、TCIE、HTIE、TEIE、MEM2MEM |
| `DMA_CNDTR1~7` | 剩余计数 | NDT[15:0] |
| `DMA_CPAR1~7` | 外设地址 | PA[31:0] |
| `DMA_CMAR1~7` | 存储器地址 | MA[31:0] |
| `DMA_ISR` | 全局状态 | GIF、TCIF、HTIF、TEIF |
| `DMA_IFCR` | 清标志 | 对应位写 1 |

### 0x27 数据一致性与 volatile

DMA 在后台改内存，编译器并不知道。如果缓冲区变量没有 `volatile`，优化后 CPU 可能一直读寄存器里的旧值：

```c
volatile uint16_t AD_Value[4];   /* DMA 会改，必须 volatile */
```

另外，DMA 写完一块数据后，CPU 读到的可能是“半新半旧”的内容。要保证一致性：

- 等 TC 标志再读整块；
- 或用 HT/TC 双缓冲，处理“已经完成”的那一半；
- 不要在多字节数据（如 32 位浮点）正在被 DMA 写时去读它。

Cortex-M3 没有 D-Cache，所以不存在缓存一致性问题；但编译器优化和 CPU 乱序仍然要求 `volatile` + 合适的同步点。

### 0x28 带宽与瓶颈

AHB 总线 72 MHz、32 位宽，理论带宽 288 MB/s；DMA 每个数据项要占用一次读 + 一次写，实际吞吐要打对折。常见外设的需求：

| 外设 | 数据率 | 占 AHB 比例 |
| ---- | ------ | ----------- |
| ADC 4 通道 × 10 kHz × 2 B | 80 KB/s | 可忽略 |
| USART 115200 × 1 B | 11.5 KB/s | 可忽略 |
| SPI 18 MHz × 1 B | 2.25 MB/s | 约 1.5% |
| 并口/摄像头 | 数十 MB/s | 需要仔细评估 |

所以大多数场景 DMA 都不会成为瓶颈，真正要担心的是**外设本身的速度**和**CPU 与 DMA 抢同一条总线**导致的延迟抖动。

## 0x30 硬件与信号

DMA 本身不接外部引脚，但它的“请求源”都在外设上，所以硬件设计其实是外设的设计：

- **ADC**：PA0 ~ PA3 模拟输入，VDDA 滤波，输入不超过 3.3 V；
- **USART1**：PA9(TX)/PA10(RX)，TX/RX 交叉、共地；
- **SPI1**：PA5/PA6/PA7 + 片选；
- **定时器**：TRGO 触发 ADC，做等间隔采样。

如果 DMA 搬的是外部器件的数据（SPI Flash、屏幕），要注意器件的时序和 DMA 宽度匹配；DMA 只负责“搬”，不负责“等器件准备好”。

## 0x40 代码实现

本篇代码文件：

| 文件 | 作用 |
| ---- | ---- |
| `MyDMA.h` / `MyDMA.c` | M2M 通用搬运 |
| `AD.h` / `AD.c` | ADC 四通道 + DMA |
| `Serial.h` / `Serial.c` | USART1 + DMA 发送 |
| `main.c` | 各实验主程序 |

### 0x41 存储器到存储器（M2M）

`MyDMA.h`：

```c
#ifndef __MYDMA_H
#define __MYDMA_H

#include "stm32f10x.h"

void MyDMA_Init(uint32_t AddrA, uint32_t AddrB, uint16_t Size);
void MyDMA_Transfer(uint16_t Size);
uint8_t MyDMA_IsDone(void);

#endif
```

`MyDMA.c`：

```c
#include "MyDMA.h"

void MyDMA_Init(uint32_t AddrA, uint32_t AddrB, uint16_t Size)
{
    RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1, ENABLE);

    DMA_InitTypeDef DMA_InitStructure;
    DMA_InitStructure.DMA_PeripheralBaseAddr = AddrA;   /* 源 */
    DMA_InitStructure.DMA_MemoryBaseAddr = AddrB;       /* 目的 */
    DMA_InitStructure.DMA_DIR = DMA_DIR_PeripheralSRC;
    DMA_InitStructure.DMA_BufferSize = Size;
    DMA_InitStructure.DMA_PeripheralInc = DMA_PeripheralInc_Enable;
    DMA_InitStructure.DMA_MemoryInc = DMA_MemoryInc_Enable;
    DMA_InitStructure.DMA_PeripheralDataSize = DMA_PeripheralDataSize_Byte;
    DMA_InitStructure.DMA_MemoryDataSize = DMA_MemoryDataSize_Byte;
    DMA_InitStructure.DMA_Mode = DMA_Mode_Normal;
    DMA_InitStructure.DMA_Priority = DMA_Priority_Medium;
    DMA_InitStructure.DMA_M2M = DMA_M2M_Enable;
    DMA_Init(DMA1_Channel1, &DMA_InitStructure);

    DMA_Cmd(DMA1_Channel1, DISABLE);
}

void MyDMA_Transfer(uint16_t Size)
{
    DMA_Cmd(DMA1_Channel1, DISABLE);
    DMA_SetCurrDataCounter(DMA1_Channel1, Size);   /* 只能在关闭时写 */
    DMA_Cmd(DMA1_Channel1, ENABLE);

    while (DMA_GetFlagStatus(DMA1_FLAG_TC1) == RESET);
    DMA_ClearFlag(DMA1_FLAG_TC1);
}

uint8_t MyDMA_IsDone(void)
{
    return DMA_GetFlagStatus(DMA1_FLAG_TC1) == SET;
}
```

`main.c`：

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "OLED.h"
#include "MyDMA.h"

uint8_t DataA[] = {0x01, 0x02, 0x03, 0x04};
uint8_t DataB[4];

int main(void)
{
    OLED_Init();
    MyDMA_Init((uint32_t)DataA, (uint32_t)DataB, 4);

    OLED_ShowString(1, 1, "DataA:");
    OLED_ShowString(3, 1, "DataB:");

    while (1)
    {
        MyDMA_Transfer(4);

        OLED_ShowHexNum(1, 7, DataA[0], 2);
        OLED_ShowHexNum(1, 10, DataA[1], 2);
        OLED_ShowHexNum(1, 13, DataA[2], 2);
        OLED_ShowHexNum(2, 1, DataB[0], 2);
        OLED_ShowHexNum(2, 4, DataB[1], 2);
        OLED_ShowHexNum(2, 7, DataB[2], 2);
        OLED_ShowHexNum(2, 10, DataB[3], 2);

        Delay_ms(1000);
    }
}
```

现象：`DataB` 从 `00 00 00 00` 变成 `01 02 03 04`，再改 `DataA` 会同步过去。

### 0x42 ADC 四通道 + DMA

`AD.h`：

```c
#ifndef __AD_H
#define __AD_H

#include "stm32f10x.h"

extern uint16_t AD_Value[4];

void AD_Init(void);
uint16_t AD_GetmV(uint8_t Channel);

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

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AIN;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_0 | GPIO_Pin_1 | GPIO_Pin_2 | GPIO_Pin_3;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    ADC_RegularChannelConfig(ADC1, ADC_Channel_0, 1, ADC_SampleTime_55Cycles5);
    ADC_RegularChannelConfig(ADC1, ADC_Channel_1, 2, ADC_SampleTime_55Cycles5);
    ADC_RegularChannelConfig(ADC1, ADC_Channel_2, 3, ADC_SampleTime_55Cycles5);
    ADC_RegularChannelConfig(ADC1, ADC_Channel_3, 4, ADC_SampleTime_55Cycles5);

    ADC_InitTypeDef ADC_InitStructure;
    ADC_InitStructure.ADC_Mode = ADC_Mode_Independent;
    ADC_InitStructure.ADC_DataAlign = ADC_DataAlign_Right;
    ADC_InitStructure.ADC_ExternalTrigConv = ADC_ExternalTrigConv_None;
    ADC_InitStructure.ADC_ContinuousConvMode = ENABLE;
    ADC_InitStructure.ADC_ScanConvMode = ENABLE;
    ADC_InitStructure.ADC_NbrOfChannel = 4;
    ADC_Init(ADC1, &ADC_InitStructure);

    ADC_DMACmd(ADC1, ENABLE);

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

    ADC_SoftwareStartConvCmd(ADC1, ENABLE);
}

uint16_t AD_GetmV(uint8_t Channel)
{
    return (uint32_t)AD_Value[Channel] * 3300 / 4095;
}
```

`main.c` 与 ADC 篇相同：四行显示 `AD0 ~ AD3`。

### 0x43 USART1 发送 + DMA

串口发送是 M2P 的典型场景：把缓冲区交给 DMA，CPU 立刻返回。

`Serial.h`：

```c
#ifndef __SERIAL_H
#define __SERIAL_H

#include "stm32f10x.h"

void Serial_Init(void);
void Serial_SendByte(uint8_t Byte);
void Serial_SendArray(uint8_t *Array, uint16_t Length);
void Serial_SendString(char *String);
void Serial_DMA_Send(uint8_t *Buffer, uint16_t Length);
uint8_t Serial_DMA_IsBusy(void);

#endif
```

`Serial.c`：

```c
#include "Serial.h"

void Serial_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_9;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_10;
    GPIO_Init(GPIOA, &GPIO_InitStructure);

    USART_InitTypeDef USART_InitStructure;
    USART_InitStructure.USART_BaudRate = 115200;
    USART_InitStructure.USART_WordLength = USART_WordLength_8b;
    USART_InitStructure.USART_StopBits = USART_StopBits_1;
    USART_InitStructure.USART_Parity = USART_Parity_No;
    USART_InitStructure.USART_HardwareFlowControl = USART_HardwareFlowControl_None;
    USART_InitStructure.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    USART_Init(USART1, &USART_InitStructure);

    /* DMA1_Channel4 固定对应 USART1_TX */
    DMA_InitTypeDef DMA_InitStructure;
    DMA_InitStructure.DMA_PeripheralBaseAddr = (uint32_t)&USART1->DR;
    DMA_InitStructure.DMA_MemoryBaseAddr = 0;      /* 每次发送时再设 */
    DMA_InitStructure.DMA_DIR = DMA_DIR_PeripheralDST;
    DMA_InitStructure.DMA_BufferSize = 0;
    DMA_InitStructure.DMA_PeripheralInc = DMA_PeripheralInc_Disable;
    DMA_InitStructure.DMA_MemoryInc = DMA_MemoryInc_Enable;
    DMA_InitStructure.DMA_PeripheralDataSize = DMA_PeripheralDataSize_Byte;
    DMA_InitStructure.DMA_MemoryDataSize = DMA_MemoryDataSize_Byte;
    DMA_InitStructure.DMA_Mode = DMA_Mode_Normal;
    DMA_InitStructure.DMA_Priority = DMA_Priority_Medium;
    DMA_InitStructure.DMA_M2M = DMA_M2M_Disable;
    DMA_Init(DMA1_Channel4, &DMA_InitStructure);

    USART_DMACmd(USART1, USART_DMAReq_Tx, ENABLE);
    USART_Cmd(USART1, ENABLE);
}

void Serial_SendByte(uint8_t Byte)
{
    USART_SendData(USART1, Byte);
    while (USART_GetFlagStatus(USART1, USART_FLAG_TXE) == RESET);
}

void Serial_SendArray(uint8_t *Array, uint16_t Length)
{
    for (uint16_t i = 0; i < Length; i++)
    {
        Serial_SendByte(Array[i]);
    }
}

void Serial_SendString(char *String)
{
    for (uint8_t i = 0; String[i] != '\0'; i++)
    {
        Serial_SendByte(String[i]);
    }
}

void Serial_DMA_Send(uint8_t *Buffer, uint16_t Length)
{
    DMA_Cmd(DMA1_Channel4, DISABLE);

    DMA1_Channel4->CMAR = (uint32_t)Buffer;         /* 目的内存地址 */
    DMA_SetCurrDataCounter(DMA1_Channel4, Length);

    DMA_Cmd(DMA1_Channel4, ENABLE);
}

uint8_t Serial_DMA_IsBusy(void)
{
    return DMA_GetFlagStatus(DMA1_FLAG_TC4) == RESET;
}
```

`main.c`：

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "Serial.h"

uint8_t Text[] = "DMA send test\r\n";

int main(void)
{
    Serial_Init();

    while (1)
    {
        Serial_DMA_Send(Text, sizeof(Text) - 1);
        Delay_ms(1000);
    }
}
```

注意：DMA 发送期间不能改 `Text`，否则发出去的是“半新半旧”的内容；要连续发多帧，等 `Serial_DMA_IsBusy()` 为 0 再改缓冲区。

### 0x44 半传输双缓冲

F103 没有硬件双缓冲，用 HT + TC 中断实现：

```c
#define BUF_LEN 64

uint16_t ADC_Buf[BUF_LEN * 2];   /* 前半 + 后半 */

void DMA1_Channel1_IRQHandler(void)
{
    if (DMA_GetITStatus(DMA1_IT_HT1) == SET)
    {
        /* 前半满：处理 ADC_Buf[0 .. BUF_LEN-1] */
        DMA_ClearITPendingBit(DMA1_IT_HT1);
    }

    if (DMA_GetITStatus(DMA1_IT_TC1) == SET)
    {
        /* 后半满：处理 ADC_Buf[BUF_LEN .. 2*BUF_LEN-1] */
        DMA_ClearITPendingBit(DMA1_IT_TC1);
    }
}
```

配置时把 `DMA_BufferSize` 设成 `2 * BUF_LEN`，开 HT/TC 中断，循环模式：

```c
DMA_ITConfig(DMA1_Channel1, DMA_IT_HT | DMA_IT_TC, ENABLE);

NVIC_InitTypeDef NVIC_InitStructure;
NVIC_InitStructure.NVIC_IRQChannel = DMA1_Channel1_IRQn;
NVIC_InitStructure.NVIC_IRQChannelCmd = ENABLE;
NVIC_InitStructure.NVIC_IRQChannelPreemptionPriority = 1;
NVIC_InitStructure.NVIC_IRQChannelSubPriority = 1;
NVIC_Init(&NVIC_InitStructure);
```

这样 CPU 处理前半时 DMA 写后半，处理后半时 DMA 写前半，适合音频、振动采样。

### 0x45 定时器触发 ADC + DMA（等间隔采样）

连续模式是“能多快跑多快”，采样间隔由转换时间决定；要严格等间隔，就用定时器 TRGO 触发：

```c
void AD_TimerTrigger_Init(void)
{
    /* TIM3：72MHz / 7200 / 100 = 100Hz */
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM3, ENABLE);

    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStructure;
    TIM_TimeBaseInitStructure.TIM_ClockDivision = TIM_CKD_DIV1;
    TIM_TimeBaseInitStructure.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStructure.TIM_Period = 100 - 1;
    TIM_TimeBaseInitStructure.TIM_Prescaler = 7200 - 1;
    TIM_TimeBaseInitStructure.TIM_RepetitionCounter = 0;
    TIM_TimeBaseInit(TIM3, &TIM_TimeBaseInitStructure);

    TIM_SelectOutputTrigger(TIM3, TIM_TRGOSource_Update);
    TIM_Cmd(TIM3, ENABLE);

    /* ADC 规则组触发源选 T3_TRGO：
       在 ADC_Init 之前设置 ADC_ExternalTrigConv = ADC_ExternalTrigConv_T3_TRGO;
       这里只负责打开外部触发。关闭连续模式（DISABLE），每次触发转一个序列。 */
    ADC_ExternalTrigConvCmd(ADC1, ENABLE);
}
```

配置要点：

- `ADC_ContinuousConvMode = DISABLE`，每次触发只转一个序列；
- DMA 仍然用 `Circular`，缓冲区大小 = 序列长度 × 采样点数；
- 采样率 = 定时器更新频率，与代码执行时间无关；
- `TCONV` 必须小于定时器周期，否则会丢触发。

这样得到的就是一台“100 Hz、4 通道”的数据采集器，适合画波形、做 FFT。

### 0x29 常用外设 DMA 配置速查

| 外设 | 通道 | 方向 | 宽度 | 模式 |
| ---- | ---- | ---- | ---- | ---- |
| ADC1 | DMA1_Ch1 | P2M | HalfWord | Circular |
| SPI1_RX | DMA1_Ch2 | P2M | Byte | Circular |
| SPI1_TX | DMA1_Ch3 | M2P | Byte | Normal |
| USART1_TX | DMA1_Ch4 | M2P | Byte | Normal |
| USART1_RX | DMA1_Ch5 | P2M | Byte | Circular + IDLE |
| USART2_RX | DMA1_Ch6 | P2M | Byte | Circular |
| USART2_TX | DMA1_Ch7 | M2P | Byte | Normal |
| I2C1_TX | DMA1_Ch6 | M2P | Byte | Normal |
| I2C1_RX | DMA1_Ch7 | P2M | Byte | Normal |
| DAC_CH1 | DMA1_Ch3 | M2P | HalfWord | Circular |

这张表就是“选通道”的唯一依据；配置前先查表，能省掉一半“DMA 没反应”的问题。

### 0x46 DMA + SPI 刷屏思路

SPI 屏刷新是 DMA 的经典用法：

```text
显存数组 → DMA1_Ch3 → SPI1->DR → 屏幕
```

流程：

1. 把一帧图像写进 `FrameBuf[320*240*2]`；
2. 拉低屏幕 CS，发“写显存”命令；
3. 启动 DMA 把 `FrameBuf` 搬到 `SPI1->DR`；
4. 等 TC，拉高 CS。

这样 CPU 只负责画图，传输交给 DMA，帧率能明显提升。注意 SPI 的发送速度要小于屏幕控制器支持的写周期，必要时间隔加 `Delay` 或降低 SPI 时钟。

SPI 发送的 DMA 配置片段：

```c
void SPI_DMA_Send(uint8_t *Buffer, uint16_t Length)
{
    DMA_Cmd(DMA1_Channel3, DISABLE);
    DMA1_Channel3->CMAR = (uint32_t)Buffer;
    DMA_SetCurrDataCounter(DMA1_Channel3, Length);
    DMA_Cmd(DMA1_Channel3, ENABLE);

    while (DMA_GetFlagStatus(DMA1_FLAG_TC3) == RESET);
    DMA_ClearFlag(DMA1_FLAG_TC3);
}
```

`SPI1_TX` 固定用 `DMA1_Channel3`；发送前要保证 `SPI_I2S_FLAG_TXE` 已经置位（SPI 已使能、CS 已拉低），否则第一个字节可能丢。发送完成后等 `TC3` 再拉高 CS，避免最后一个字节被截断。

## 0x50 实验与调试

### 0x51 M2M 实验

预期：上电后 `DataB` 等于 `DataA`。把 `MyDMA_Transfer(4)` 改成 `MyDMA_Transfer(2)`，只有前两个字节被搬，后两个保持 0——这能验证计数器确实在起作用。

### 0x52 时间对比

用 GPIO 翻转 + 示波器，或 `SysTick` 计时，比较：

| 方式 | 搬 1000 字节耗时 | CPU 占用 |
| ---- | ---------------- | -------- |
| for 循环 | 约 1000 × 0.28 µs = 280 µs | 100% |
| DMA | 约 1000 × 1 个 AHB 周期 ≈ 几十 µs | 接近 0 |

实际数值和主频、总线宽度、优化等级有关，但“DMA 几乎不占 CPU”这个结论是稳定的。

### 0x53 ADC + DMA 调试

- OLED 四行数值应随四个电位器独立变化；
- 用万用表对比 `AD_GetmV()`；
- 如果四行一样：检查规则序列排名、DMA 缓冲区大小；
- 如果数值不刷新：检查 `ADC_SoftwareStartConvCmd`、DMA 是否使能、是否循环模式。

### 0x54 串口 DMA 调试

- 串口助手应收到 `DMA send test`；
- 发送期间改 `Text` 会看到乱码/截断，这是正常现象（缓冲区被改写）；
- 连续发送时，等 TC 标志再改缓冲区。

## 0x60 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| DMA 完全没反应 | 时钟没开、通道错、EN 没置 | 查 `RCC_AHBPeriphClockCmd`、通道映射 |
| 只搬了一个数据 | Normal 模式 + 没重装 | 改 Circular 或每次重设 CNDTR |
| 数据全一样 | 地址没自增 | `DMA_MemoryInc_Enable` |
| 数据错位/高低字节颠倒 | 宽度不匹配 | ADC 用 HalfWord，串口用 Byte |
| 传输计数器为 0 | 写 CNDTR 时通道没关 | 先 `DMA_Cmd(DISABLE)` |
| 串口只发一半 | DMA 还没发完就改缓冲区 | 等 TC 标志 |
| 中断不进 | 没开 TCIE/HTIE、NVIC 没配 | 检查 `DMA_ITConfig` |
| 清不掉标志 | 清的方式不对 | 用 `DMA_ClearFlag`/`DMA_ClearITPendingBit` |
| ADC 数值串通道 | 规则序列和数组顺序不一致 | 按排名对应下标 |
| 双缓冲数据打架 | 处理速度和采样率不匹配 | 加大缓冲、降采样率、提高优先级 |

## 0x70 小结

| 场景 | 通道 | 方向 | 模式 |
| ---- | ---- | ---- | ---- |
| 数组搬运 | 任意 | M2M | Normal + 软件触发 |
| ADC 多通道 | DMA1_Ch1 | P2M | Circular + 硬件触发 |
| USART1 发送 | DMA1_Ch4 | M2P | Normal |
| USART1 接收 | DMA1_Ch5 | P2M | Circular + IDLE |
| 双缓冲采样 | DMA1_Ch1 | P2M | Circular + HT/TC 中断 |

DMA 的配置项看着多，其实就三句话：**从哪搬、搬到哪、搬多少**；方向、宽度、自增、循环都是为这三件事服务的。

### 思考题

1. 为什么 M2M 不能用硬件触发？
2. CNDTR 为什么必须在通道关闭时写？
3. ADC 四通道、DMA 缓冲区 4 个半字，如果 `DMA_BufferSize` 写成 2，OLED 上会看到什么？
4. 串口 DMA 发送时，CPU 怎么知道“可以改缓冲区了”？
5. 半传输双缓冲相比“整块完成再处理”，优势在哪里？
