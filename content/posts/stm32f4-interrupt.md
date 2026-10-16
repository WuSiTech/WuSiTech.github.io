+++
title = "STM32F4 配置中断"
date = "2026-10-14T22:30:00+08:00"
draft = true
description = "以 STM32F411CEU6 与标准外设库为例，完整讲解和实现PA0 下降沿触发 EXTI0 中断、翻转 PC13 电平的中断链路：使能时钟、配置GPIO、SYSCFG映射(相当于F1的AFIO)、EXTI 触发条件、NVIC 优先级分组与中断服务程序."
categories = [ "STM32" ]
tags = [ "STM32F4", "中断" ]
cover = "/images/interrupt-path.jpg"
banner = "images/banner.webp"
+++

参考：[https://www.bilibili.com/video/BV1th411z7sn](https://www.bilibili.com/video/BV1th411z7sn)

# 中断是什么？有什么用？

> 中断的主要作用是让CPU在运行程序时能及时响应外部或内部的突发事件，从而提高系统效率、保证系统可靠性并满足实时处理需求。 中断使CPU暂停当前任务，转去执行中断服务程序，处理完后再返回原任务继续执行。

简而言之:中断就是“优先处理”。当出现触发中断的条件时，系统暂停当前的函数，去处理中断（需注意中断是阻塞的）。合理的中断能提高STM32处理的效率

# STM32的中断链路是什么？

![中断链路](/images/interrupt-path.jpg)

如图

# 如何实现？（标准库）
