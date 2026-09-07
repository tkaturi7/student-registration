# Student Registration Application with OWASP ZAP

This project demonstrates a security-gated CI/CD pipeline for a Node.js student registration application running on Google Kubernetes Engine.

Every push to the `main` branch builds the candidate image and runs an OWASP ZAP Baseline scan on the GitHub-hosted runner. The candidate image is pushed to Artifact Registry and deployed to GKE only when the ZAP security gate passes.

## Architecture

```text
Developer
   |
   | git push origin main
   v
GitHub Actions Runner
   |
   +-- Start temporary MySQL service
   +-- Install and validate Node.js dependencies
   +-- Build the candidate Docker image
   +-- Start the candidate application locally
   +-- Wait for the readiness endpoint
   +-- Run OWASP ZAP Baseline scan
   +-- Upload ZAP reports
   |
   +-- ZAP failure
   |      |
   |      +-- Workflow fails
   |      +-- Image is not pushed
   |      +-- GKE is not updated
   |
   +-- ZAP success
          |
          +-- Authenticate to Google Cloud
          +-- Push the commit SHA image
          +-- Deploy the image to GKE
          +-- Wait for a successful rollout

