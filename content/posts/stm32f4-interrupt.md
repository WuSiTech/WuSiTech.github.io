+++
title = "STM32F4 配置中断"
date = "2026-10-16T19:30:00+08:00"
draft = false
description = "以 STM32F411CEU6 与标准外设库为例，完整讲解和实现PA0 下降沿触发 EXTI0 中断、翻转 PC13 电平的中断链路：使能时钟、配置GPIO、SYSCFG映射(相当于F1的AFIO)、EXTI 触发条件、NVIC 优先级分组与中断服务程序."
categories = [ "STM32" ]
tags = [ "STM32F4", "中断" ]
cover = "/images/interrupt-path.jpg"
banner = "images/banner.webp"
+++

参考：[https://www.bilibili.com/video/BV1th411z7sn](https://www.bilibili.com/video/BV1th411z7sn)

# 中断是什么？有什么用？

> 中断的主要作用是让CPU在运行程序时能及时响应外部或内部的突发事件，从而提高系统效率、保证系统可靠性并满足实时处理需求。 中断使CPU暂停当前任务，转去执行中断服务程序，处理完后再返回原任务继续执行。

在课程视频里如此：
• 中断：在主程序运行过程中，出现了特定的中断触发条件（中断源），使得CPU暂停当前正在运行的程序，转而去处理中断程序，处理完成后又返回原来被暂停的位置继续运行

• 中断优先级：当有多个中断源同时申请中断时，CPU会根据中断源的轻重缓急进行裁决，优先响应更加紧急的中断源（就像病人去医院一样，让病情危急的病人先治疗）

![](/images/20261016-185545.webp)

• 中断嵌套：当一个中断程序正在运行时，又有新的更高优先级的中断源申请中断，CPU再次暂停当前中断程序，转而去处理新的中断程序，处理完成后依次进行返回

如图阐释了中断的工作原理：
![中断可以嵌套](/images/20261016-184440.webp)

需注意中断是阻塞的，因此不能在中断函数中调用所需时间过长的函数，否则会影响主函数的执行产生混乱。

我认为，中断可以代替一部分轮询，提高运行的效率。~~（这不就是特殊的回调吗ᗜˬᗜ）~~

# STM32的中断链路是什么？

![中断链路](/images/interrupt-path.jpg)

如图，通过SYSCFG，可以从GPIOx中选出要中断的引脚。然后接到EXTI，EXTI负责检测进来的信号是否满足触发中断的条件（条件由自己设置）。当触发中断的条件时，信号通过EXTIx和其他的通路触发NVIC，NVIC负责将信息汇报CPU，此时中断触发。

对于SYSCFG，我们可以把它看做一个“接线器”，它负责将P?x（指PAx，PBx,...）接到对应的EXTI。值得注意的是，PAx/PBx...等相同x但不同GPIOx的引脚共用一个SYSCFG寄存器，也就是说，当设置PA0通过SYSCFG连接到EXTI0时，PB0,PC0等等就不能使用中断，否则会引发未知错误。

![SYSCFG/AFIO](/images/20261016-185707.webp)

对于EXTI，他是一个“检测器”和“控制器”。检测前端来的信号是否满足条件，以及控制EXTIx等通道传输中断信号。如图，ST公司将P?0-P?4的线分别映射到EXTI0-EXTI4，但是后续5-15，ST将其分别映射到两个EXTI通路中P?5-P?9共同使用EXTI9_5，P?10-P?15同理。

那可能有人会问：如果使用了P?5-P?15，在EXTI9_5或EXTI15_10中该如何判定到底是哪个口引起的中断呢？
其实，中断信号储存在寄存器内，可以使用if (EXTI->PR & (1 << x)) 来判断和执行（x取5-15，是P?x的x。PR是挂起寄存器的意思），如下图。~~（看不懂的话可以配课看的www）~~![](/images/20261016-185755.webp)

NVIC是一个外设，用于管理和传递中断，还可以设置优先级（见上面优先级的图）![](/images/20261016-185446.webp)

在STM32中实现中断，本质上就是打通这三个“关卡”。

# 如何实现？（标准库）

##### 先理清一下步骤。

时钟使能->设置GPIO引脚->设置SYSCFG->设置EXTI->设置NVIC->写中断函数（这一步随便，我倾向于最后写）

```c
#include "main.h"
//设置TimingDelay，可能是我的库的问题必须要写
static __IO uint32_t TimingDelay;
void TimingDelay_Decrement(void){if (TimingDelay != 0x00) TimingDelay--;}


//中断函数（其实不一定非要写到主程序里）
void EXTI0_IRQHandler(void)
{
   if (EXTI_GetITStatus(EXTI_Line0) != RESET)
    {
        GPIO_ToggleBits(GPIOC, GPIO_Pin_13);
        EXTI_ClearITPendingBit(EXTI_Line0);
    }
    
}



int main(void)
{
    //使能时钟
    RCC_AHB1PeriphClockCmd(RCC_AHB1Periph_GPIOA, ENABLE);  // GPIOA
    RCC_AHB1PeriphClockCmd(RCC_AHB1Periph_GPIOC, ENABLE);  // GPIOC
    //注意，SYSCFG也要使能
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_SYSCFG, ENABLE); // SYSCFG



    //初始化引脚
    GPIO_InitTypeDef GPIO_Struct;
    GPIO_Struct.GPIO_Mode=GPIO_Mode_IN; //输入模式，用于中断
    GPIO_Struct.GPIO_OType=GPIO_OType_PP;
    GPIO_Struct.GPIO_Pin=GPIO_Pin_0;
    GPIO_Struct.GPIO_PuPd=GPIO_PuPd_UP;
    GPIO_Struct.GPIO_Speed=GPIO_High_Speed;
    GPIO_Init(GPIOA,&GPIO_Struct);
    
    GPIO_Struct.GPIO_Mode=GPIO_Mode_OUT;//输出，在这里连接了灯。用于检测中断
    GPIO_Struct.GPIO_OType=GPIO_OType_PP;//
    GPIO_Struct.GPIO_Pin=GPIO_Pin_13;//
    GPIO_Struct.GPIO_PuPd=GPIO_PuPd_UP;//
    GPIO_Struct.GPIO_Speed=GPIO_High_Speed;//
    GPIO_Init(GPIOC,&GPIO_Struct);//



    //初始化SYSCFG，F1系列使用初始化AFIO的函数
    SYSCFG_EXTILineConfig(EXTI_PortSourceGPIOA, EXTI_PinSource0);
    
    //设置EXTI
    EXTI_InitTypeDef EXTI_Struct;
    EXTI_Struct.EXTI_Line=EXTI_Line0;
    EXTI_Struct.EXTI_LineCmd=ENABLE;
    EXTI_Struct.EXTI_Mode=EXTI_Mode_Interrupt;
    EXTI_Struct.EXTI_Trigger=EXTI_Trigger_Falling;
    EXTI_Init(&EXTI_Struct);


    //设置NVIC
    NVIC_InitTypeDef NVIC_Struct;
    NVIC_PriorityGroupConfig(NVIC_PriorityGroup_2);
    NVIC_Struct.NVIC_IRQChannel=EXTI0_IRQn;
    NVIC_Struct.NVIC_IRQChannelCmd=ENABLE;
    NVIC_Struct.NVIC_IRQChannelPreemptionPriority=2;
    NVIC_Struct.NVIC_IRQChannelSubPriority=2;
    NVIC_Init(&NVIC_Struct);


    while(1){
        //空循环，防止意外
    }
}
```

下面有几个点要详细展开：

##### 一.SYSCFG的配置

```c
SYSCFG_EXTILineConfig(EXTI_PortSourceGPIOx, EXTI_PinSource);
////库里是这么写的EXTI_PortSourceGPIOx
/** @defgroup SYSCFG_EXTI_Port_Sources 
  * @{
  */ 
#define EXTI_PortSourceGPIOA       ((uint8_t)0x00)
#define EXTI_PortSourceGPIOB       ((uint8_t)0x01)
#define EXTI_PortSourceGPIOC       ((uint8_t)0x02)
#define EXTI_PortSourceGPIOD       ((uint8_t)0x03)
#define EXTI_PortSourceGPIOE       ((uint8_t)0x04)
#define EXTI_PortSourceGPIOF       ((uint8_t)0x05)
#define EXTI_PortSourceGPIOG       ((uint8_t)0x06)
#define EXTI_PortSourceGPIOH       ((uint8_t)0x07)
#define EXTI_PortSourceGPIOI       ((uint8_t)0x08)
#define EXTI_PortSourceGPIOJ       ((uint8_t)0x09)
#define EXTI_PortSourceGPIOK       ((uint8_t)0x0A)


#define IS_EXTI_PORT_SOURCE(PORTSOURCE) (((PORTSOURCE) == EXTI_PortSourceGPIOA) || \
                                         ((PORTSOURCE) == EXTI_PortSourceGPIOB) || \
                                         ((PORTSOURCE) == EXTI_PortSourceGPIOC) || \
                                         ((PORTSOURCE) == EXTI_PortSourceGPIOD) || \
                                         ((PORTSOURCE) == EXTI_PortSourceGPIOE) || \
                                         ((PORTSOURCE) == EXTI_PortSourceGPIOF) || \
                                         ((PORTSOURCE) == EXTI_PortSourceGPIOG) || \
                                         ((PORTSOURCE) == EXTI_PortSourceGPIOH) || \
                                         ((PORTSOURCE) == EXTI_PortSourceGPIOI) || \
                                         ((PORTSOURCE) == EXTI_PortSourceGPIOJ) || \
                                         ((PORTSOURCE) == EXTI_PortSourceGPIOK))
                                         
/**
  * @}
  */ 
//这么写的EXTI_PinSource
/** @defgroup SYSCFG_EXTI_Pin_Sources 
  * @{
  */ 
#define EXTI_PinSource0            ((uint8_t)0x00)
#define EXTI_PinSource1            ((uint8_t)0x01)
#define EXTI_PinSource2            ((uint8_t)0x02)
#define EXTI_PinSource3            ((uint8_t)0x03)
#define EXTI_PinSource4            ((uint8_t)0x04)
#define EXTI_PinSource5            ((uint8_t)0x05)
#define EXTI_PinSource6            ((uint8_t)0x06)
#define EXTI_PinSource7            ((uint8_t)0x07)
#define EXTI_PinSource8            ((uint8_t)0x08)
#define EXTI_PinSource9            ((uint8_t)0x09)
#define EXTI_PinSource10           ((uint8_t)0x0A)
#define EXTI_PinSource11           ((uint8_t)0x0B)
#define EXTI_PinSource12           ((uint8_t)0x0C)
#define EXTI_PinSource13           ((uint8_t)0x0D)
#define EXTI_PinSource14           ((uint8_t)0x0E)
#define EXTI_PinSource15           ((uint8_t)0x0F)
#define IS_EXTI_PIN_SOURCE(PINSOURCE) (((PINSOURCE) == EXTI_PinSource0)  || \
                                       ((PINSOURCE) == EXTI_PinSource1)  || \
                                       ((PINSOURCE) == EXTI_PinSource2)  || \
                                       ((PINSOURCE) == EXTI_PinSource3)  || \
                                       ((PINSOURCE) == EXTI_PinSource4)  || \
                                       ((PINSOURCE) == EXTI_PinSource5)  || \
                                       ((PINSOURCE) == EXTI_PinSource6)  || \
                                       ((PINSOURCE) == EXTI_PinSource7)  || \
                                       ((PINSOURCE) == EXTI_PinSource8)  || \
                                       ((PINSOURCE) == EXTI_PinSource9)  || \
                                       ((PINSOURCE) == EXTI_PinSource10) || \
                                       ((PINSOURCE) == EXTI_PinSource11) || \
                                       ((PINSOURCE) == EXTI_PinSource12) || \
                                       ((PINSOURCE) == EXTI_PinSource13) || \
                                       ((PINSOURCE) == EXTI_PinSource14) || \
                                       ((PINSOURCE) == EXTI_PinSource15))
/**
  * @}
  */ 
```

P?x中相同x只能初始化一个,你不能既初始化A1又初始化B1

当你调用 `SYSCFG_EXTILineConfig(EXTI_PortSourceGPIOA, EXTI_PinSource1)` 时，底层操作的是 `SYSCFG->EXTICR` 寄存器。
这个寄存器中，EXTI Line 1 只有 4 个比特位（`EXTICR[0]` 的位 7:4），用来记录当前接的是哪个 Port（A=0000, B=0001, C=0010...）。

如果你按顺序写如下代码：

```c
// 第一步：将 EXTI1 映射到 PA1
SYSCFG_EXTILineConfig(EXTI_PortSourceGPIOA, EXTI_PinSource1);
// 第二步：将 EXTI1 映射到 PB1
SYSCFG_EXTILineConfig(EXTI_PortSourceGPIOB, EXTI_PinSource1);
```

实际结果：`EXTICR` 对应的 4 个位先被写成 `0000`，紧接着被覆盖写成 `0001`。最终 EXTI Line 1 只连接到了 PB1，PA1 彻底断开连接**。**

##### 二.EXTI的配置（详见官方文档，实在懒得写了QAQ）

```c
    EXTI_InitTypeDef EXTI_Struct;
    EXTI_Struct.EXTI_Line=EXTI_Line0;
    EXTI_Struct.EXTI_LineCmd=ENABLE;
    EXTI_Struct.EXTI_Mode=EXTI_Mode_Interrupt;
    EXTI_Struct.EXTI_Trigger=EXTI_Trigger_Falling;
    EXTI_Init(&EXTI_Struct);
```

唯二要注意的：~~BAKA~~

1.EXTI.Linex要引的和你要中断的P?x的x相同
2.EXTI_Mode可以是EXTI_Mode_Interrupt(中断模式)或者EXTI_Mode_Event(事件模式，选择此模式时当满足中断条件时不会触发中断而是触发事件)
3.EXTI_Trigger有三种模式：上升沿、下降沿、上升沿和下降沿（定义看下面代码）

```c
typedef enum
{
  EXTI_Trigger_Rising = 0x08,
  EXTI_Trigger_Falling = 0x0C,  
  EXTI_Trigger_Rising_Falling = 0x10
}EXTITrigger_TypeDef;
```

##### 三.NVIC的配置：

```c
    NVIC_InitTypeDef NVIC_Struct;
    NVIC_PriorityGroupConfig(NVIC_PriorityGroup_2);
    NVIC_Struct.NVIC_IRQChannel=EXTI0_IRQn;
    NVIC_Struct.NVIC_IRQChannelCmd=ENABLE;
    NVIC_Struct.NVIC_IRQChannelPreemptionPriority=2;
    NVIC_Struct.NVIC_IRQChannelSubPriority=2;
    NVIC_Init(&NVIC_Struct);
```

首先一个问题就是优先级组：NVIC_PriorityGroupConfig();规定**整个芯片(程序)只能用一个优先级组**（主要是和后面的NVIC_Struct.NVIC_IRQChannelPreemptionPriority/NVIC_Struct.NVIC_IRQChannelSubPriority配置有关）

第二，NVIC_Struct.NVIC_IRQChannel，我们可以看他的定义

```c
uint8_t NVIC_IRQChannel;                    
/*!< Specifies the IRQ channel to be enabled or disabled.
This parameter can be an enumerator of @ref IRQn_Type 
enumeration (For the complete STM32 Devices IRQ Channels
list, please refer to stm32f4xx.h file) */
```

参见stm32f4xx.h文件。其实跟EXTIx的分组命名方式一样（EXTI0-4,EXTI9_5,EXTI15_10,还有PVD（特殊的外设中断，不是“EXTI_PVD”,就是PVD）等等），不过后面加了一个_IRQn。~~（肥肠通透啊）~~
注意和前面要用一样的x

第三，NVIC_IRQChannelPreemptionPriority（抢）和NVIC_IRQChannelSubPriority（响）

这两个玩意是分组的抢占优先级和响应优先级，和前面分组（NVIC_PriorityGroupConfig）的关系如下![](/images/20261016-193817.webp)

> 最核心的一条铁律是：数值越小，优先级越高。
> 为了让你彻底弄清它们，我们可以打个比方，并总结它们的核心区别：
> 1\. 抢占优先级（Preemption Priority）—— 决定“能不能打断”
> 作用：决定一个中断是否能够打断当前正在执行的其他中断（即中断嵌套）。
> 规则：高抢占优先级的中断，可以打断低抢占优先级的中断。
> 相等时：如果两个中断的抢占优先级相同，它们不能互相打断。
> 2\. 响应优先级（Response Priority）—— 决定“谁先排队”
> 作用：当两个中断的抢占优先级相同，且同时发生时，决定谁先执行。
> 规则：响应优先级高的先执行。
> 致命限制：响应优先级不能造成中断嵌套。如果一个中断正在运行，哪怕另一个中断的响应优先级再高，也必须等当前中断执行完毕，才能执行下一个。

> 假设配置了三个中断 A、B、C：
> A：抢占 1，响应 1
> B：抢占 2，响应 2
> C：抢占 1，响应 2
> 情景 1：A 正在运行，B 触发了
> A 的抢占(1) 高于 B 的抢占(2)，B 不能打断 A，必须等 A 执行完，B 才能执行。
> 情景 2：A 正在运行，C 触发了
> A 的抢占(1) 等于 C 的抢占(1)，C 不能打断 A。必须等 A 执行完，再去执行 C（哪怕 C 的响应优先级是 2，比 A 的 1 低，也无法改变不能嵌套的事实）。
> 情景 3：A 和 C 同时触发了
> A(抢占1, 响应1) 和 C(抢占1, 响应2)。
> 抢占相同，看响应。A 的响应(1) 高于 C 的响应(2)，A 先执行，C 后执行。
> 情景 4：B 正在运行，A 触发了
> B 的抢占(2) 低于 A 的抢占(1)，A 立刻打断 B（中断嵌套），A 执行完后，继续执行 B。

##### 四.中断函数

这个函数的类型必须是void，且名称要严格遵循向量表的要求。（命名void EXTIx_IRQHandler(void)和EXTIx的分组命名方式一样（EXTI0-4,EXTI9_5,EXTI15_10,还有PVD（特殊的外设中断，不是“EXTI_PVD”,就是PVD）等等），不过后面加了一个_IRQHandler。）~~（也是肥肠通透啊）~~

最后就完成了。在操作中发现，如果KEIL的编译器使用O3优化，必须要加一行

```c
if (EXTI_GetITStatus(EXTI_Line0) != RESET)
```

按理来说不加也没什么大问题，但实际上不加的话整个中断函数会被优化掉~~（神了）~~

最后送大家一个baka（意义不明）

```c
//⠀⠀⠀⣠⠤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⠀⠀
// ⠀⠀⡜⠁⠀⠈⢢⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⠋⠷⠶⠱⡄
// ⠀⢸⣸⣿⠀⠀⠀⠙⢦⡀⠀⠀⠀⠀⠀⠀⠀⢀⡴⠫⢀⣖⡃⢀⣸⢹
// ⠀⡇⣿⣿⣶⣤⡀⠀⠀⠙⢆⠀⠀⠀⠀⠀⣠⡪⢀⣤⣾⣿⣿⣿⣿⣸
// ⠀⡇⠛⠛⠛⢿⣿⣷⣦⣀⠀⣳⣄⠀⢠⣾⠇⣠⣾⣿⣿⣿⣿⣿⣿⣽
// ⠀⠯⣠⣠⣤⣤⣤⣭⣭⡽⠿⠾⠞⠛⠷⠧⣾⣿⣿⣯⣿⡛⣽⣿⡿⡼
// ⠀⡇⣿⣿⣿⣿⠟⠋⠁⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠻⣿⣿⣮⡛⢿⠃
// ⠀⣧⣛⣭⡾⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢿⣿⣷⣎⡇
// ⠀⡸⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢿⣷⣟⡇
// ⣜⣿⣿⡧⠀⠀⠀⠀⠀⡀⠀⠀⠀⠀⠀⠀⣄⠀⠀⠀⠀⠀⣸⣿⡜⡄
// ⠉⠉⢹⡇⠀⠀⠀⢀⣞⠡⠀⠀⠀⠀⠀⠀⡝⣦⠀⠀⠀⠀⢿⣿⣿⣹
// ⠀⠀⢸⠁⠀⠀⢠⣏⣨⣉⡃⠀⠀⠀⢀⣜⡉⢉⣇⠀⠀⠀⢹⡄⠀⠀
// ⠀⠀⡾⠄⠀⠀⢸⣾⢏⡍⡏⠑⠆⠀⢿⣻⣿⣿⣿⠀⠀⢰⠈⡇⠀⠀
// ⠀⢰⢇⢀⣆⠀⢸⠙⠾⠽⠃⠀⠀⠀⠘⠿⡿⠟⢹⠀⢀⡎⠀⡇⠀⠀
// ⠀⠘⢺⣻⡺⣦⣫⡀⠀⠀⠀⣄⣀⣀⠀⠀⠀⠀⢜⣠⣾⡙⣆⡇⠀⠀
// ⠀⠀⠀⠙⢿⡿⡝⠿⢧⡢⣠⣤⣍⣀⣤⡄⢀⣞⣿⡿⣻⣿⠞⠀⠀⠀
// ⠀⠀⠀⢠⠏⠄⠐⠀⣼⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠳⢤⣉⢳⠀⠀⠀
// ⢀⡠⠖⠉⠀⠀⣠⠇⣿⡿⣿⡿⢹⣿⣿⣿⣿⣧⣠⡀⠀⠈⠉⢢⡀⠀
// ⢿⠀⠀⣠⠴⣋⡤⠚⠛⠛⠛⠛⠛⠛⠛⠛⠙⠛⠛⢿⣦⣄⠀⢈⡇⠀
// ⠈⢓⣤⣵⣾⠁⣀⣀⠤⣤⣀⠀⠀⠀⠀⢀⡤⠶⠤⢌⡹⠿⠷⠻⢤⡀
// ⢰⠋⠈⠉⠘⠋⠁⠀⠀⠈⠙⠳⢄⣀⡴⠉⠀⠀⠀⠀⠙⠂⠀⠀⢀⡇
// ⢸⡠⡀⠀⠒⠂⠐⠢⠀⣀⠀⠀⠀⠀⠀⢀⠤⠚⠀⠀⢸⣔⢄⠀⢾⠀
// ⠀⠑⠸⢿⠀⠀⠀⠀⢈⡗⠭⣖⡒⠒⢊⣱⠀⠀⠀⠀⢨⠟⠂⠚⠋⠀
// ⠀⠀⠀⠘⠦⣄⣀⣠⠞⠀⠀⠀⠈⠉⠉⠀⠳⠤⠤⡤⠞⠀⠀⠀⠀⠀
```
