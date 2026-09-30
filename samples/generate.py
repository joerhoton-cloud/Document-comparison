"""Generate sample original/revised contracts (DOCX, PDF, TXT) for trying the app.

Requires: pip install python-docx reportlab
Run from this folder: python3 generate.py
"""
from docx import Document
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

ORIGINAL = [
    ("h", "Media Monitoring Services Agreement"),
    ("p", 'This Media Monitoring Services Agreement (the "Agreement") is entered into as of January 1, 2026 by and between Provider Inc. ("Provider") and Example Corp. ("Customer").'),
    ("h", "1. Services"),
    ("p", "Provider shall deliver daily media monitoring reports covering print, broadcast and online sources in the United States and Canada."),
    ("p", "Reports will be delivered by email no later than 8:00 a.m. Eastern Time each business day."),
    ("h", "2. Fees and Payment"),
    ("p", "Customer shall pay an annual subscription fee of $48,000, payable quarterly in advance. Invoices are due within thirty (30) days of receipt."),
    ("p", "Late payments shall accrue interest at the rate of 1.5% per month."),
    ("h", "3. Term and Termination"),
    ("p", "The initial term of this Agreement is twelve (12) months and shall automatically renew for successive one-year terms unless either party gives sixty (60) days written notice."),
    ("p", "Either party may terminate this Agreement for material breach that remains uncured thirty (30) days after written notice."),
    ("h", "4. Confidentiality"),
    ("p", "Each party shall protect the other party's Confidential Information using at least the same degree of care it uses to protect its own confidential information, but no less than reasonable care."),
    ("h", "5. Limitation of Liability"),
    ("p", "In no event shall either party's aggregate liability exceed the fees paid by Customer in the twelve (12) months preceding the claim."),
    ("h", "6. Governing Law"),
    ("p", "This Agreement shall be governed by the laws of the State of Illinois."),
]

REVISED = [
    ("h", "Media Monitoring Services Agreement"),
    ("p", 'This Media Monitoring Services Agreement (the "Agreement") is entered into as of February 1, 2026 by and between Provider Inc. ("Provider") and Example Corp. ("Customer").'),
    ("h", "1. Services"),
    ("p", "Provider shall deliver daily media monitoring reports covering print, broadcast, podcast and online sources in the United States, Canada and Mexico."),
    ("p", "Reports will be delivered through the online platform no later than 7:00 a.m. Eastern Time each business day."),
    ("p", "Provider shall also deliver a monthly executive summary with share-of-voice analysis."),
    ("h", "2. Fees and Payment"),
    ("p", "Customer shall pay an annual subscription fee of $52,500, payable annually in advance. Invoices are due within forty-five (45) days of receipt."),
    ("h", "3. Term and Termination"),
    ("p", "The initial term of this Agreement is twenty-four (24) months and shall automatically renew for successive one-year terms unless either party gives ninety (90) days written notice."),
    ("p", "Either party may terminate this Agreement for material breach that remains uncured thirty (30) days after written notice."),
    ("h", "4. Confidentiality"),
    ("p", "Each party shall protect the other party's Confidential Information using at least the same degree of care it uses to protect its own confidential information, but no less than reasonable care."),
    ("h", "5. Limitation of Liability"),
    ("p", "In no event shall either party's aggregate liability exceed the fees paid by Customer in the twelve (12) months preceding the claim."),
    ("h", "6. Governing Law"),
    ("p", "This Agreement shall be governed by the laws of the State of Delaware."),
]


def make_docx(items, path):
    d = Document()
    for kind, text in items:
        if kind == "h":
            d.add_heading(text, level=2 if text[0].isdigit() else 1)
        else:
            d.add_paragraph(text)
    d.save(path)


def make_pdf(items, path):
    styles = getSampleStyleSheet()
    doc = SimpleDocTemplate(path, pagesize=letter)
    story = []
    for kind, text in items:
        story.append(Paragraph(text.replace("&", "&amp;"), styles["Heading2" if kind == "h" else "BodyText"]))
        story.append(Spacer(1, 6))
    doc.build(story)


if __name__ == "__main__":
    make_docx(ORIGINAL, "contract-original.docx")
    make_docx(REVISED, "contract-revised.docx")
    make_pdf(ORIGINAL, "contract-original.pdf")
    make_pdf(REVISED, "contract-revised.pdf")
    with open("contract-original.txt", "w") as f:
        f.write("\n\n".join(t for _, t in ORIGINAL) + "\n")
