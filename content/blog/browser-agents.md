---
title: "Browser Agents Are Holding Back"
date: "2026-03-08"
subtitle: "What's wrong with current browser-use agents, and how to make them actually useful."
---

# The Amnesiac That Needs Handholding

I've been using browser agents more lately, Claude's in particular. Most of my work can't go through MCP yet, so the browser is the only real interface. Here's a recollection of what I went through yesterday.

![Browser agents](browser-agents-0.png)

## Case Study: Adding Skills to Linkedin

Linkedin has probably one of the worst UIs for adding skills (possibly worse than myworkday). So I wanted to use this new piece of tech to automate it for me (seems something mundane that it'll excel at).

I gave it my projects and asked it to extract the skills and add them into Linkedin. It started off great, reading my Github READMEs, extracting the skills, and then adding those into Linkedin. But after a few minutes, the performance degraded, so I had to remind it that it was supposed to add unique skills (not just Python and API Development for the 6th time). I was watching over it, just making sure it wasn't gonna go on a Linkedin connection spree.

Here's the issue though: the entire process was slow and tiring.

## The Problem

I was watching an agent slowly screenshot the Github README, extracting the skills, then adding the skills one by one, in the midst of that forgetting that it was supposed to be deeper than just "API Development". I had to preempt it several times just to get the job half done, and I decided it was time to do it myself.

The technology has vast potential. But thinking of it as an agent manipulating the screen using tools... might be the wrong way to go about it.

# Finding the Deeper Structure in the Problem

## The Prompt

Starting with the prompt: I gave the agent a humongous task of adding 10 skills for 5 projects after referring to my Github. Is that actually one task though? Adding skills for a single project is a task. Adding a single skill is a task.

This raises the question: **do we really need a single agent to be doing all that? Can we make it faster? (the question makes the answer obvious).**

## The Execution

Execution was reasonably good, except for the fact that instructions weren't being followed. Why is that? Three possible reasons:

1. **The instruction** wasn't clear enough or what you thought "unique" meant wasn't the same as what the model thought it meant.
2. The model simply had **different priorities** (I mean when you're dealing with Linkedin's UI, you would want to focus on clicking all those buttons first).
3. The **context is diluted** because of the sheer amount of information.

For problem (1), **does correcting the model really have to be as difficult as stopping the entire flow to course correct? Can't we nudge it in the middle of its work?**

But more importantly, for problem (2) and (3), does the model really have to take on the burden of interacting with the screen and dealing with your intended task at the same time?

To expand on this: imagine your coding agent not having any tools at its disposal except for bash commands. It will need to make a curl command to request for docs, do some manoeuvre to replace text and so on. This is arguably going a level deeper than that of intent. It is going to a level of implementation. Now, the agent has 2 tasks, getting the implementation right as well as making sure the user intent is met. That's a tough ask. It also overloads your context window with stuff that you don't even need.

So, **do we need the agent to be clicking a messy interface and deal with prompt shenanigans at the same time? Could we possibly abstract these two away?**
