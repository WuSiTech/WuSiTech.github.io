+++
title = "STM32 I2C：总线原理、时序、MPU6050 与软件模拟"
date = "2026-11-03T19:30:00+08:00"
lastmod = "2026-11-06T23:59:00+08:00"
draft = false
description = "从开漏/上拉/线与讲到起始停止、ACK、重复起始、时钟拉伸与仲裁，再落到 MPU6050 的寄存器、量程换算、零偏校准与姿态解算，附完整软件 I2C 驱动、MPU6050 驱动、主程序与 12 条故障排查。"
categories = [ "STM32" ]
tags = [ "STM32", "I2C", "MPU6050", "传感器" ]
cover = "/images/pool/covers/covers-11.avif"
banner = ""
+++

总结自：[STM32入门教程-2023版](https://www.bilibili.com/video/BV1th411z7sn) 第 10 章前半（10-1 ~ 10-3）。

代码基于 **STM32F103C8T6 + STM32F10x 标准外设库 3.5.0**（API 已按 STM32F10x StdPeriph 3.5 头文件核对；Delay/OLED/Key 为课程配套驱动），不包含新建工程和接线步骤。

| 视频 | 视频里讲了什么 | 本文对应 |
| ---- | -------------- | -------- |
| 10-1 | I2C 硬件电路（开漏/上拉）、起始/停止、数据有效性、应答、读写时序、逻辑分析仪 | 0x00 ~ 0x30 |
| 10-2 | MPU6050 简介、参数、硬件电路、框图、寄存器手册 | 0x40 |
| 10-3 | 软件 I2C 读写 MPU6050（代码、显示） | 0x50 ~ 0x70 |

视频之外还补了：上拉电阻计算、时钟拉伸、总线仲裁、10 位地址、连续读、零偏校准、互补滤波姿态角、12 条故障排查。

## 0x00 I2C 是什么

I2C（Inter-Integrated Circuit）是 Philips 开发的一种**同步、半双工**串行总线，只用两根线：

- **SCL**（Serial Clock）：时钟线，由主机产生；
- **SDA**（Serial Data）：数据线，双向。

一条总线上可以挂很多设备（一主多从、多主多从），每个从设备有独立的 7 位地址。它比串口省线、比 SPI 省引脚，代价是速度慢（标准 100 kHz、快速 400 kHz）、协议更复杂、总线上拉和电容有限制。

| 特性 | I2C | SPI | UART |
| ---- | --- | --- | ---- |
| 线数 | 2 | 4 + 片选 | 2 |
| 速度 | 100/400 kHz | 几 MHz ~ 几十 MHz | 通常 ≤ 1 Mbps |
| 多设备 | 地址寻址 | 片选 | 点对点 |
| 应答 | 有 | 无 | 无（可加校验） |
| 时钟 | 同步 | 同步 | 异步 |

## 0x10 电气设计

### 0x11 开漏、上拉与线与

![I2C 总线与常见模块](/images/posts/stm32-i2c/i2c-intro.webp)

![I2C 开漏输出与上拉电阻](/images/posts/stm32-i2c/i2c-hardware.webp)

I2C 的电气设计有三个关键词：

1. **开漏输出**：每个设备的 SCL/SDA 都配成开漏（Open-Drain），只能主动拉低，不能主动拉高；
2. **上拉电阻**：总线靠外部上拉电阻回到高电平；
3. **线与**：只要有一个设备拉低，整条线就是低电平——这正是“多设备共享总线”和“应答/仲裁”的电气基础。

所以 I2C 设备不能“输出高电平”，只能“释放总线”。如果两个设备同时输出，一个拉低一个释放，结果是低电平，不会短路。

### 0x12 上拉电阻怎么算

上拉太大，上升沿变缓；上拉太小，灌电流大、低电平抬高。粗略范围：

```text
Rp(max) = tr / (0.8473 × Cb)      （上升时间限制）
Rp(min) = (VDD - VOL) / IOL       （灌电流限制）
```

3.3 V、总线电容 100 pF、上升时间 300 ns：

```text
Rp(max) = 300ns / (0.8473 × 100pF) ≈ 3.5 kΩ
Rp(min) = (3.3 - 0.4) / 3mA ≈ 1 kΩ
```

所以常见取值 **2.2 kΩ ~ 4.7 kΩ**。设备多、线长、电容大时取小一点（2.2 kΩ）；低功耗场合取大一点（10 kΩ），但速度要降。

### 0x13 总线电容与线长

I2C 规范限制总线电容约 **400 pF**。普通杜邦线约 50 ~ 100 pF/m，接 4 ~ 5 个模块就可能接近上限。表现是波形上升沿变圆、高速下误码。解决办法：

- 缩短线、减少设备；
- 降低速率到 100 kHz 或更低；
- 用 I2C 缓冲器/中继器（PCA9515）；
- 改用差分总线（RS485/CAN）。

### 0x14 速率模式与时间参数

| 模式 | 速率 | 典型用途 |
| ---- | ---- | -------- |
| Standard | 100 kHz | 普通传感器、EEPROM |
| Fast | 400 kHz | MPU6050、OLED |
| Fast+ | 1 MHz | 短距离、强上拉 |
| High-speed | 3.4 MHz | 专用器件，少用 |

100 kHz 下的关键时间：

```text
tLOW  ≥ 4.7 µs      SCL 低电平
tHIGH ≥ 4.0 µs      SCL 高电平
tr    ≤ 1000 ns     SDA/SCL 上升时间
tf    ≤ 300 ns      下降时间
```

400 kHz 时分别缩到 1.3 µs、0.6 µs、300 ns。软件 I2C 的 `Delay_us(10)` 一个半周期约 10 µs，实际速率只有 50 kHz 左右；要跑 100 kHz，延时改 5 µs，并确认上升沿够快。

### 0x15 怎么测总线是否健康

上电不通信时，用万用表量：

- SCL/SDA 对 VCC 的电阻：应等于上拉电阻（几 kΩ），不是 0 也不是无穷大；
- SCL/SDA 对 GND 的电阻：应为无穷大，若很小说明短路；
- 通信时用示波器看高电平：应接近 3.3 V，低电平应低于 0.4 V。

总线电容可以用 LCR 表或示波器上升时间估算：

```text
Cb ≈ tr / (0.8473 × Rp)
```

上升时间 500 ns、上拉 4.7 kΩ，则 Cb ≈ 125 pF。超过 400 pF 就要缩短线或降低速率。

## 0x20 时序

### 0x21 起始与停止

- **起始条件（S）**：SCL 高电平期间，SDA 由高变低；
- **停止条件（P）**：SCL 高电平期间，SDA 由低变高；
- **重复起始（Sr）**：不先停止，直接再发一个起始，用于“写地址 → 读数据”切换方向。

关键：起始/停止都发生在 **SCL 高电平**期间，而普通数据变化只能发生在 SCL 低电平期间。这是区分“命令”和“数据”的唯一标志。

![I2C 起始、数据/应答、停止时序](/images/posts/stm32-i2c/i2c-timing.svg)

### 0x22 数据有效性

- SCL **低电平**期间，SDA 才允许变化；
- SCL **高电平**期间，SDA 必须稳定，接收方在这个窗口采样；
- 数据**高位先行**（MSB first）。

### 0x23 应答与非应答

每发完 8 位（一个字节），接收方要在第 9 个时钟拉低 SDA 表示 **ACK**；不拉低就是 **NACK**。

| 场景 | 谁发 ACK/NACK |
| ---- | ------------- |
| 主机写数据 | 从机发 ACK |
| 主机读数据 | 主机发 ACK（最后一个字节发 NACK） |
| 地址无设备 | 无人拉低 → 主机读到 NACK |

主机读数据时，每读完一个字节要自己发 ACK 表示“继续读”，最后一个字节发 NACK 表示“读完了”，然后发停止条件。

### 0x24 时钟拉伸

从机来不及处理时，可以**拉住 SCL 低电平**不放，主机必须等它释放才能继续。这就是时钟拉伸（Clock Stretching）。

软件模拟 I2C 时，如果从机拉低 SCL，主机写高也没用（线与），下一步会读到低电平。严谨的实现要检查：

```c
/* 释放 SCL 后等它真的变高（处理时钟拉伸） */
MyI2C_W_SCL(1);
while (MyI2C_R_SCL() == 0);   /* 超时要跳出 */
```

大多数传感器（包括 MPU6050）不拉伸时钟，简单实现可以省掉；但做通用驱动时最好加上超时保护。

### 0x25 总线仲裁

多主机同时发数据时，每个主机一边发一边读 SDA：

- 自己发 1，读回 0 → 别人在拉低，自己输了仲裁，立刻停止发送；
- 自己发 0，读回 0 → 继续。

仲裁不会破坏数据，输的一方自动退出，赢的一方继续。这是 I2C 多主模式的精髓，软件模拟一般不需要实现。

## 0x30 帧格式

### 0x31 地址与读写位

地址是 7 位（0 ~ 127），加上 1 位读写位凑成 8 位：

```text
写：地址 << 1 | 0
读：地址 << 1 | 1
```

MPU6050 的 7 位地址是 `0x68`，写地址 `0xD0`，读地址 `0xD1`；AD0 接高则变 0x69。

10 位地址用两字节：第一字节 `11110xx + R/W`，第二字节是低 8 位。普通传感器很少用。

### 0x32 写寄存器

```text
S | 从机地址+W | ACK | 寄存器地址 | ACK | 数据 | ACK | P
```

### 0x33 读寄存器

```text
S | 从机地址+W | ACK | 寄存器地址 | ACK |
Sr | 从机地址+R | ACK | 数据 | NACK | P
```

读操作里有两个起始：第一个是“告诉从机我要读哪个寄存器”，第二个（重复起始）才是“开始读”。如果省略重复起始，从机不会把数据发出来。

### 0x34 连续读

MPU6050 的加速度/角速度数据是连续的 14 个寄存器（0x3B ~ 0x48）。地址会自动递增，所以可以“读一个地址，然后连续读 N 个字节”：

```text
S | 0xD0 | ACK | 0x3B | ACK | Sr | 0xD1 | ACK | Data0 | ACK | ... | Data13 | NACK | P
```

连续读比读 14 次寄存器快得多，也避免“读到一半数据更新”的不一致。

### 0x35 逻辑分析仪看波形

抓 SCL/SDA，解码器选 I2C，能看到：

- 起始条件；
- 地址 + ACK；
- 寄存器地址 + ACK；
- 重复起始；
- 数据 + ACK/NACK；
- 停止条件。

如果解码器报“NACK”，先查地址、上拉、供电；如果报“总线错误”，查起始/停止是否在 SCL 高电平期间产生。

### 0x36 EEPROM 与页写

I2C 总线上最常见的另一类器件是 EEPROM（AT24C02）。它和 MPU6050 的读时序一样，但写有“页”限制：

- AT24C02：2 Kbit = 256 字节，页大小 8 字节，地址 0x50 ~ 0x57；
- 写一个字节后要等 **5 ms** 写周期，期间不响应；
- 页写最多 8 字节，超过会回卷到页首，覆盖前面的数据。

```c
void AT24C02_WriteByte(uint8_t Reg, uint8_t Data)
{
    MyI2C_Start();
    MyI2C_SendByte(0xA0);      /* 0x50 << 1 */
    MyI2C_ReceiveAck();
    MyI2C_SendByte(Reg);
    MyI2C_ReceiveAck();
    MyI2C_SendByte(Data);
    MyI2C_ReceiveAck();
    MyI2C_Stop();

    Delay_ms(5);               /* 等写周期 */
}

uint8_t AT24C02_ReadByte(uint8_t Reg)
{
    uint8_t Data;

    MyI2C_Start();
    MyI2C_SendByte(0xA0);
    MyI2C_ReceiveAck();
    MyI2C_SendByte(Reg);
    MyI2C_ReceiveAck();

    MyI2C_Start();
    MyI2C_SendByte(0xA1);
    MyI2C_ReceiveAck();
    Data = MyI2C_ReceiveByte();
    MyI2C_SendAck(1);
    MyI2C_Stop();

    return Data;
}
```

EEPROM 的地址空间大于 256 字节时，高 3 位地址写在设备地址的低 3 位里（0x50 | (addr >> 8)），低 8 位写在寄存器地址里。

## 0x40 MPU6050

### 0x41 芯片与轴定义

![MPU6050 模块引脚](/images/posts/stm32-i2c/mpu-pins.webp)

MPU6050 是 InvenSense 的 6 轴姿态传感器：

- **3 轴加速度计**：测 X/Y/Z 三个方向的加速度（含重力），单位 g；
- **3 轴陀螺仪**：测绕 X/Y/Z 三个轴的角速度，单位 °/s；
- 内部还有温度传感器，以及一个可用于外接磁力计的 I2C 主机接口（XCL、XDA）。

模块引脚：

| 引脚 | 功能 |
| ---- | ---- |
| VCC、GND | 电源（模块一般带 3.3 V 稳压） |
| SCL、SDA | I2C 通信 |
| XCL、XDA | 主机 I2C，接外接磁力计 |
| AD0 | 从机地址最低位：0 → 0x68，1 → 0x69 |
| INT | 中断输出 |

### 0x42 关键寄存器

![MPU6050 参数与地址](/images/posts/stm32-i2c/mpu-params.webp)

| 地址 | 名称 | 作用 | 常用值 |
| ---- | ---- | ---- | ------ |
| 0x75 | WHO_AM_I | 身份识别，默认 0x68 | 读出来应为 0x68 |
| 0x6B | PWR_MGMT_1 | 电源管理 | 0x01：退出睡眠，时钟选 X 轴陀螺 PLL |
| 0x6C | PWR_MGMT_2 | 轴待机 | 0x00：全部开启 |
| 0x19 | SMPLRT_DIV | 采样分频 | 0x09：1 kHz / (1+9) = 100 Hz |
| 0x1A | CONFIG | 数字低通滤波 | 0x06：约 5 Hz |
| 0x1B | GYRO_CONFIG | 陀螺量程 | 0x18：±2000 °/s |
| 0x1C | ACCEL_CONFIG | 加速度量程 | 0x18：±16 g |
| 0x37 | INT_PIN_CFG | 中断引脚配置 | 按需 |
| 0x38 | INT_ENABLE | 中断使能 | 按需 |
| 0x3B ~ 0x40 | ACCEL_XOUT_H ~ ZOUT_L | 加速度 3 轴，各 2 字节 | 大端 |
| 0x41 ~ 0x42 | TEMP_OUT_H/L | 温度 | — |
| 0x43 ~ 0x48 | GYRO_XOUT_H ~ ZOUT_L | 角速度 3 轴 | 大端 |

### 0x43 量程与换算

| 量程 | 灵敏度 |
| ---- | ------ |
| ±2 g | 16384 LSB/g |
| ±4 g | 8192 LSB/g |
| ±8 g | 4096 LSB/g |
| ±16 g | 2048 LSB/g |
| ±250 °/s | 131 LSB/(°/s) |
| ±500 °/s | 65.5 LSB/(°/s) |
| ±1000 °/s | 32.8 LSB/(°/s) |
| ±2000 °/s | 16.4 LSB/(°/s) |

```c
float ax = AccX / 2048.0f;      /* g，对应 ±16 g */
float gx = GyroX / 16.4f;       /* °/s，对应 ±2000 °/s */
```

量程选得越大，能测的范围越大，但分辨率越低。做平衡车/云台一般用 ±2 g ~ ±4 g、±500 °/s；做剧烈运动才用到 ±16 g。

### 0x44 采样率与低通滤波

- `SMPLRT_DIV`：采样分频，`采样率 = 1kHz / (1 + DIV)`（DLPF 开启时）；
- `CONFIG` 的低 3 位选 DLPF 带宽：0 = 260 Hz，1 = 184 Hz，2 = 94 Hz，3 = 44 Hz，4 = 21 Hz，5 = 10 Hz，6 = 5 Hz。

采样率要大于信号最高频率的 2 倍；DLPF 带宽要略高于有用信号，太低会延迟，太高会引入噪声。

### 0x45 温度与自检

温度寄存器 0x41/0x42：

```text
T = TEMP_OUT / 340 + 36.53
```

自检（Self-Test）通过配置寄存器让内部激励作用于传感器，比较输出变化是否在范围内。课程里不要求，产品出厂自检可以用。

### 0x46 FIFO 与中断

高速采样时，逐个读寄存器会被 I2C 速度限制。MPU6050 内置 512 字节 FIFO：

| 寄存器 | 作用 |
| ------ | ---- |
| 0x23 FIFO_EN | 使能哪些数据进 FIFO（加速度、陀螺、温度） |
| 0x72 FIFO_COUNT_H/L | FIFO 里有多少字节 |
| 0x74 FIFO_R_W | 读 FIFO |

```c
void MPU6050_FIFO_Enable(void)
{
    MPU6050_WriteReg(0x23, 0x78);   /* 加速度 + 陀螺都进 FIFO */
    MPU6050_WriteReg(0x6A, 0x40);   /* FIFO 使能 */
}

uint16_t MPU6050_FIFO_Count(void)
{
    uint8_t H = MPU6050_ReadReg(0x72);
    uint8_t L = MPU6050_ReadReg(0x73);
    return (H << 8) | L;
}
```

FIFO 的好处：一次突发读走几十组数据，减少 I2C 事务开销，也保证采样时刻一致。代价是要处理“FIFO 溢出”和“数据对齐”。

### 0x47 中断引脚

MPU6050 的 INT 可以配置成“数据就绪”“FIFO 溢出”“运动检测”等：

- `0x37 INT_PIN_CFG`：推挽/开漏、高/低有效、锁存；
- `0x38 INT_ENABLE`：使能哪类中断；
- `0x3A INT_STATUS`：查询中断源。

把 INT 接到 STM32 的 EXTI，就能“有数据才读”，比定时轮询省 CPU。

## 0x50 软件 I2C

软件 I2C 就是用 GPIO 手动翻转 SCL/SDA，完全按上面的时序来。优点是简单、不挑引脚；缺点是占 CPU、速度慢（一般几十 kHz）。

### 0x51 引脚与底层

`MyI2C.h`：

```c
#ifndef __MYI2C_H
#define __MYI2C_H

#include "stm32f10x.h"

void MyI2C_Init(void);
void MyI2C_Start(void);
void MyI2C_Stop(void);
void MyI2C_SendByte(uint8_t Byte);
uint8_t MyI2C_ReceiveByte(void);
void MyI2C_SendAck(uint8_t AckBit);
uint8_t MyI2C_ReceiveAck(void);

#endif
```

`MyI2C.c`：

```c
#include "MyI2C.h"
#include "Delay.h"

/* PB10 = SCL，PB11 = SDA，开漏输出 */
void MyI2C_W_SCL(uint8_t BitValue)
{
    GPIO_WriteBit(GPIOB, GPIO_Pin_10, (BitAction)BitValue);
    Delay_us(10);
}

void MyI2C_W_SDA(uint8_t BitValue)
{
    GPIO_WriteBit(GPIOB, GPIO_Pin_11, (BitAction)BitValue);
    Delay_us(10);
}

uint8_t MyI2C_R_SDA(void)
{
    uint8_t BitValue = GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_11);
    Delay_us(10);
    return BitValue;
}

uint8_t MyI2C_R_SCL(void)
{
    return GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_10);
}

void MyI2C_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);

    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_Out_OD;   /* 开漏 */
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_10 | GPIO_Pin_11;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(GPIOB, &GPIO_InitStructure);

    GPIO_SetBits(GPIOB, GPIO_Pin_10 | GPIO_Pin_11);    /* 释放总线 */
}
```

### 0x52 起始、停止、收发字节

```c
void MyI2C_Start(void)
{
    MyI2C_W_SDA(1);
    MyI2C_W_SCL(1);
    MyI2C_W_SDA(0);   /* SCL 高时 SDA 下降 = 起始 */
    MyI2C_W_SCL(0);
}

void MyI2C_Stop(void)
{
    MyI2C_W_SDA(0);
    MyI2C_W_SCL(1);
    MyI2C_W_SDA(1);   /* SCL 高时 SDA 上升 = 停止 */
}

void MyI2C_SendByte(uint8_t Byte)
{
    for (uint8_t i = 0; i < 8; i++)
    {
        MyI2C_W_SDA(Byte & (0x80 >> i));   /* 高位先行 */
        MyI2C_W_SCL(1);
        MyI2C_W_SCL(0);
    }
}

uint8_t MyI2C_ReceiveByte(void)
{
    uint8_t Byte = 0x00;
    MyI2C_W_SDA(1);                        /* 主机释放 SDA，交给从机 */
    for (uint8_t i = 0; i < 8; i++)
    {
        MyI2C_W_SCL(1);
        if (MyI2C_R_SDA() == 1) Byte |= (0x80 >> i);
        MyI2C_W_SCL(0);
    }
    return Byte;
}

void MyI2C_SendAck(uint8_t AckBit)
{
    MyI2C_W_SDA(AckBit);
    MyI2C_W_SCL(1);
    MyI2C_W_SCL(0);
}

uint8_t MyI2C_ReceiveAck(void)
{
    uint8_t AckBit;
    MyI2C_W_SDA(1);
    MyI2C_W_SCL(1);
    AckBit = MyI2C_R_SDA();
    MyI2C_W_SCL(0);
    return AckBit;
}
```

### 0x53 连续读与超时

连续读的写法：

```c
void MyI2C_ReadBytes(uint8_t Addr, uint8_t Reg, uint8_t *Buf, uint8_t Len)
{
    MyI2C_Start();
    MyI2C_SendByte(Addr << 1);        /* 写 */
    MyI2C_ReceiveAck();
    MyI2C_SendByte(Reg);
    MyI2C_ReceiveAck();

    MyI2C_Start();                    /* 重复起始 */
    MyI2C_SendByte((Addr << 1) | 1);  /* 读 */
    MyI2C_ReceiveAck();

    for (uint8_t i = 0; i < Len; i++)
    {
        Buf[i] = MyI2C_ReceiveByte();
        MyI2C_SendAck(i == Len - 1);  /* 最后一个 NACK */
    }

    MyI2C_Stop();
}
```

超时保护（避免从机拉死总线导致死循环）：

```c
uint8_t MyI2C_WaitSCLHigh(uint16_t Timeout)
{
    while (MyI2C_R_SCL() == 0)
    {
        if (--Timeout == 0) return 0;   /* 超时失败 */
    }
    return 1;
}
```

### 0x54 提高软件 I2C 速度

软件 I2C 的速率由 `Delay_us()` 决定。想从 50 kHz 提到 100 kHz：

```c
void MyI2C_W_SCL(uint8_t BitValue)
{
    GPIO_WriteBit(GPIOB, GPIO_Pin_10, (BitAction)BitValue);
    Delay_us(5);            /* 半周期 5µs → 约 100kHz */
}
```

进一步优化：

- 用 `GPIOB->BSRR/BRR` 直接置位/清零，比 `GPIO_WriteBit` 快；
- 编译开 `-O2`；
- 关中断会影响时序，通信期间别长时间关中断；
- 上升沿由 RC 决定，延时太小反而采不到，先示波器看波形再提速。

### 0x56 软件 I2C 与硬件 I2C 对比

| 项目 | 软件 I2C | 硬件 I2C |
| ---- | -------- | -------- |
| 引脚 | 任意 GPIO | 固定/重映射 |
| 速率 | 几十 kHz | 100/400 kHz |
| CPU 占用 | 高 | 低 |
| 时序精度 | 受中断影响 | 硬件保证 |
| 多主/仲裁 | 不支持 | 支持 |
| 调试 | 抓波形即可 | 要看事件标志 |
| 代码量 | 小 | 中 |

先用软件 I2C 把时序跑通，再换硬件 I2C；产品里优先硬件 I2C + DMA。

## 0x60 MPU6050 驱动

### 0x61 寄存器读写

`MPU6050.h`：

```c
#ifndef __MPU6050_H
#define __MPU6050_H

#include "stm32f10x.h"

#define MPU6050_ADDRESS 0x68

void MPU6050_Init(void);
void MPU6050_WriteReg(uint8_t RegAddress, uint8_t Data);
uint8_t MPU6050_ReadReg(uint8_t RegAddress);
void MPU6050_GetData(int16_t *AccX, int16_t *AccY, int16_t *AccZ,
                     int16_t *GyroX, int16_t *GyroY, int16_t *GyroZ);
uint8_t MPU6050_WhoAmI(void);

#endif
```

`MPU6050.c`：

```c
#include "MPU6050.h"
#include "MyI2C.h"

void MPU6050_WriteReg(uint8_t RegAddress, uint8_t Data)
{
    MyI2C_Start();
    MyI2C_SendByte(MPU6050_ADDRESS << 1);
    MyI2C_ReceiveAck();
    MyI2C_SendByte(RegAddress);
    MyI2C_ReceiveAck();
    MyI2C_SendByte(Data);
    MyI2C_ReceiveAck();
    MyI2C_Stop();
}

uint8_t MPU6050_ReadReg(uint8_t RegAddress)
{
    uint8_t Data;

    MyI2C_Start();
    MyI2C_SendByte(MPU6050_ADDRESS << 1);
    MyI2C_ReceiveAck();
    MyI2C_SendByte(RegAddress);
    MyI2C_ReceiveAck();

    MyI2C_Start();                          /* 重复起始 */
    MyI2C_SendByte((MPU6050_ADDRESS << 1) | 1);
    MyI2C_ReceiveAck();
    Data = MyI2C_ReceiveByte();
    MyI2C_SendAck(1);                       /* NACK */
    MyI2C_Stop();

    return Data;
}

uint8_t MPU6050_WhoAmI(void)
{
    return MPU6050_ReadReg(0x75);
}

void MPU6050_Init(void)
{
    MyI2C_Init();

    MPU6050_WriteReg(0x6B, 0x01);   /* 退出睡眠，时钟 PLL X 轴 */
    MPU6050_WriteReg(0x19, 0x09);   /* 100 Hz 采样 */
    MPU6050_WriteReg(0x1A, 0x06);   /* DLPF 5 Hz */
    MPU6050_WriteReg(0x1B, 0x18);   /* 陀螺 ±2000 °/s */
    MPU6050_WriteReg(0x1C, 0x18);   /* 加速度 ±16 g */
}

void MPU6050_GetData(int16_t *AccX, int16_t *AccY, int16_t *AccZ,
                     int16_t *GyroX, int16_t *GyroY, int16_t *GyroZ)
{
    uint8_t Data[14];

    MyI2C_Start();
    MyI2C_SendByte(MPU6050_ADDRESS << 1);
    MyI2C_ReceiveAck();
    MyI2C_SendByte(0x3B);
    MyI2C_ReceiveAck();

    MyI2C_Start();
    MyI2C_SendByte((MPU6050_ADDRESS << 1) | 1);
    MyI2C_ReceiveAck();

    for (uint8_t i = 0; i < 14; i++)
    {
        Data[i] = MyI2C_ReceiveByte();
        MyI2C_SendAck(i == 13);
    }
    MyI2C_Stop();

    *AccX  = (Data[0]  << 8) | Data[1];
    *AccY  = (Data[2]  << 8) | Data[3];
    *AccZ  = (Data[4]  << 8) | Data[5];
    *GyroX = (Data[8]  << 8) | Data[9];
    *GyroY = (Data[10] << 8) | Data[11];
    *GyroZ = (Data[12] << 8) | Data[13];
}
```

### 0x62 主程序

```c
#include "stm32f10x.h"
#include "Delay.h"
#include "Serial.h"
#include "MPU6050.h"

int main(void)
{
    int16_t AccX, AccY, AccZ, GyroX, GyroY, GyroZ;

    Serial_Init();
    MPU6050_Init();

    printf("WHO_AM_I = 0x%02X\r\n", MPU6050_WhoAmI());

    while (1)
    {
        MPU6050_GetData(&AccX, &AccY, &AccZ, &GyroX, &GyroY, &GyroZ);

        printf("Acc:%.2f,%.2f,%.2f Gyro:%.2f,%.2f,%.2f\r\n",
               AccX / 2048.0f, AccY / 2048.0f, AccZ / 2048.0f,
               GyroX / 16.4f, GyroY / 16.4f, GyroZ / 16.4f);

        Delay_ms(100);
    }
}
```

### 0x63 零偏校准

陀螺仪静止时读数不为 0（零偏），积分会漂。上电静止采 500 次求平均：

```c
void MPU6050_Calibrate(int16_t *BiasX, int16_t *BiasY, int16_t *BiasZ)
{
    int32_t SumX = 0, SumY = 0, SumZ = 0;
    int16_t ax, ay, az, gx, gy, gz;

    for (uint16_t i = 0; i < 500; i++)
    {
        MPU6050_GetData(&ax, &ay, &az, &gx, &gy, &gz);
        SumX += gx;
        SumY += gy;
        SumZ += gz;
        Delay_ms(2);
    }

    *BiasX = SumX / 500;
    *BiasY = SumY / 500;
    *BiasZ = SumZ / 500;
}
```

之后每次读数减去零偏，再除以灵敏度。

### 0x64 姿态角与互补滤波

只用加速度可以算倾角：

```c
float Roll  = atan2f(AccY, AccZ) * 57.2958f;
float Pitch = atan2f(-AccX, sqrtf(AccY * AccY + AccZ * AccZ)) * 57.2958f;
```

加速度噪声大、动态响应差；陀螺积分平滑但会漂。互补滤波把两者融合：

```c
float Angle = 0.0f;

void UpdateAngle(float AccAngle, float GyroRate, float dt)
{
    Angle = 0.98f * (Angle + GyroRate * dt) + 0.02f * AccAngle;
}
```

`dt` 用定时器固定周期（如 10 ms），系数 0.98/0.02 决定“信陀螺还是信加速度”。

### 0x65 卡尔曼滤波（对比互补滤波）

互补滤波简单，但系数固定；卡尔曼滤波会根据“预测误差”和“测量噪声”动态调整权重。一维卡尔曼的核心代码：

```c
float Kalman_Update(float AccAngle, float GyroRate, float dt)
{
    static float Angle = 0, Bias = 0;
    static float P[2][2] = {{1, 0}, {0, 1}};
    const float Q_angle = 0.001f, Q_bias = 0.003f, R_measure = 0.03f;

    /* 预测 */
    Angle += dt * (GyroRate - Bias);
    P[0][0] += dt * (dt * P[1][1] - P[0][1] - P[1][0] + Q_angle);
    P[0][1] -= dt * P[1][1];
    P[1][0] -= dt * P[1][1];
    P[1][1] += Q_bias * dt;

    /* 更新 */
    float S = P[0][0] + R_measure;
    float K0 = P[0][0] / S;
    float K1 = P[1][0] / S;
    float Y = AccAngle - Angle;

    Angle += K0 * Y;
    Bias  += K1 * Y;

    float P00 = P[0][0], P01 = P[0][1];
    P[0][0] -= K0 * P00;
    P[0][1] -= K0 * P01;
    P[1][0] -= K1 * P00;
    P[1][1] -= K1 * P01;

    return Angle;
}
```

对比：

| 项目 | 互补滤波 | 卡尔曼 |
| ---- | -------- | ------ |
| 计算量 | 极小 | 中等（浮点矩阵） |
| 参数 | 一个系数 | Q/R 三个参数 |
| 效果 | 够用 | 更平滑、抗噪更好 |
| 适合 | 8 位机/低功耗 | 有 FPU 的 MCU |

F103 没有 FPU，卡尔曼用软件浮点会慢；100 Hz 以内一般还扛得住，再高就要定点化。

### 0x66 加速度计六面校准

加速度计也有零偏和灵敏度误差。把模块六个面分别朝上静置，记录三轴读数：

```text
X+ 面朝上：ax ≈ +1g
X- 面朝上：ax ≈ -1g
```

零偏和比例因子：

```text
bias_x  = (raw_x(+) + raw_x(-)) / 2
scale_x = (raw_x(+) - raw_x(-)) / 2
```

之后的读数：

```c
float ax = (RawX - bias_x) / scale_x;   /* 单位 g */
```

代码框架：

```c
typedef struct
{
    float bias[3];
    float scale[3];
} AccelCal;

void Accel_Calibrate(AccelCal *Cal)
{
    int16_t ax, ay, az, gx, gy, gz;
    int32_t Sum[6][3] = {0};   /* 6 个面 × 3 轴 */

    for (uint8_t face = 0; face < 6; face++)
    {
        /* 提示用户把第 face 个面朝上，然后采样 200 次 */
        for (uint16_t i = 0; i < 200; i++)
        {
            MPU6050_GetData(&ax, &ay, &az, &gx, &gy, &gz);
            Sum[face][0] += ax;
            Sum[face][1] += ay;
            Sum[face][2] += az;
            Delay_ms(5);
        }
    }

    /* 按实际朝向对应 +1g/-1g 的面对计算 bias/scale */
    Cal->bias[0]  = (Sum[0][0] / 200 + Sum[1][0] / 200) / 2.0f;
    Cal->scale[0] = (Sum[0][0] / 200 - Sum[1][0] / 200) / 2.0f;
    /* Y、Z 同理 */
}
```

六面校准比较麻烦，但能把几度的静态误差压到 0.5° 以内；普通实验用“静止零偏 + 单点比例”就够了。

## 0x70 实验与调试

### 0x71 先读 WHO_AM_I

上电第一件事：读 `0x75`，应为 `0x68`。

- 读到 0x00/0xFF：接线、供电、上拉、地址（AD0）有问题；
- 读到 0x68：芯片在线，再继续配置。

### 0x72 检查上拉与地址

- 模块一般自带 4.7 kΩ 上拉；自己接线要加；
- AD0 接地是 0x68，接 VCC 是 0x69；
- 用万用表量 SCL/SDA 对 VCC 的电阻，应在几 kΩ。

### 0x73 逻辑分析仪

抓一次“读 WHO_AM_I”：

```text
S | D0 | ACK | 75 | ACK | Sr | D1 | ACK | 68 | NACK | P
```

如果第二个起始（Sr）没有，说明代码写成了“停止再起始”，从机会复位状态。

### 0x74 零偏与温漂

- 静止时陀螺零偏可能几十 LSB，必须校准；
- 温度变化后零偏会变，要求高时做温补；
- 加速度计零偏小，但振动会污染。

## 0x80 常见问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| WHO_AM_I 读不到 | 接线/供电/上拉/地址 | 查 SDA/SCL、AD0、3.3 V |
| 读到 0xFF | 从机没应答，主机读的是总线高 | 查上拉、地址、芯片供电 |
| 数据全 0 | 还在 sleep 模式 | 写 0x6B = 0x01 |
| 数值偏大/偏小 | 量程与换算不匹配 | 配置和除法系数对应 |
| 角度漂移 | 陀螺零偏未校准 | 上电静止校准 |
| 读数抖动 | DLPF 太宽/电源噪声 | 调 0x1A、加滤波电容 |
| 总线卡死 | 从机拉低 SDA，主机一直等 | 加超时；SCL 手动发 9 个脉冲解锁 |
| 多设备冲突 | 地址相同 | 改 AD0 或用 I2C 多路开关 |
| 连续读错位 | 最后一个字节没 NACK | 最后一个发 NACK 再 STOP |
| 400 kHz 下不稳 | 上拉太大/线太长/电容大 | 降速、减小上拉、缩短线 |
| 读数据偶尔跳变 | 读到一半寄存器更新 | 连续读 14 字节，或加 DLPF |
| 模块发热 | 供电接反/超压 | 立即断电检查 |

## 0x90 小结

| 主题 | 要点 |
| ---- | ---- |
| 电气 | 开漏 + 上拉，线与 |
| 时序 | 起始/停止都在 SCL 高电平期间由 SDA 跳变产生 |
| 应答 | 第 9 个时钟拉低 SDA 为 ACK |
| 读寄存器 | 写地址 → 写寄存器 → 重复起始 → 读地址 → 读数据 |
| 连续读 | 一次寻址读 N 字节，最后 NACK |
| MPU6050 | 0x68 地址，0x3B 起 14 字节，±16 g / ±2000 °/s |
| 校准 | 陀螺零偏静止采样求平均 |
| 姿态 | 加速度算倾角 + 陀螺积分 + 互补滤波 |

### 思考题

1. 为什么 I2C 必须用开漏，不能用推挽？
2. 起始条件和普通数据跳变的区别是什么？
3. 读寄存器时为什么需要重复起始？省略会怎样？
4. 上拉电阻取 10 kΩ 和 2.2 kΩ 各有什么利弊？
5. 互补滤波里 0.98/0.02 调大调小分别有什么影响？

软件 I2C 把时序“翻译”成 GPIO 翻转，是理解 I2C 最好的方式；等时序吃透了，再换成硬件 I2C 外设，就只是把同样的流程交给寄存器去做。
