AI Product Image Generator
Project Overview
This project is an AI-powered application designed primarily for generating product images. Users can select a specific AI model and upload base product images (e.g., clothing). The application then prompts the selected AI image model to perform a specific task, submitting the base model image and the designated prompt for every product image simultaneously (in parallel).

Tech Stack
Framework: Nuxt

ORM: Drizzle

Database: Local database

NEVER EVER edit the migrations files, you must generate them with the proper commands, drizzle:generate and drizzle:migrate

Core Requirements & Architecture
AI Integration: Vercel's AI SDK must always be used for AI integrations, as it provides a reliable and simple abstraction layer.

Error Handling: Because the underlying AI APIs can be unstable, the system must robustly capture, log, and store all error messages.

File Management: Images must be stored in designated folders using a clean, well-structured, and efficient file management system.