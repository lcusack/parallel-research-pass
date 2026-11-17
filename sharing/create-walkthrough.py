"""Render a silent 90-second explainer. Requires pillow and imageio-ffmpeg."""
from pathlib import Path
import subprocess
import tempfile
import math
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'hosted/public/walkthrough.mp4'
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
PAPER, INK, MUTED, ORANGE, GREEN, LINE = '#f5f4ee', '#23251f', '#74766c', '#ed5c31', '#2b8059', '#dedfd5'

def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else FONT, size)

def text(draw, xy, value, size=24, fill=INK, bold=False):
    draw.multiline_text(xy, value, font=font(size, bold), fill=fill, spacing=10)

def card(draw, box):
    draw.rounded_rectangle(box, radius=14, fill='white', outline=LINE, width=2)

def base(index, label, title, subtitle):
    image = Image.new('RGB', (1280,720), PAPER)
    d = ImageDraw.Draw(image)
    for angle in range(0,180,30):
        dx,dy=math.cos(math.radians(angle))*14,math.sin(math.radians(angle))*14
        d.line((76-dx,54-dy,76+dx,54+dy),fill=ORANGE,width=3)
    text(d,(108,39),'Research Pass',25,bold=True)
    text(d,(850,43),'World ID  ×  Parallel  ×  Tempo',20,MUTED)
    d.line((60,94,1220,94),fill=LINE,width=2)
    text(d,(60,127),f'{index:02d} / {label.upper()}',16,ORANGE,bold=True)
    text(d,(60,169),title,48)
    text(d,(60,238),subtitle,24,MUTED)
    text(d,(60,666),'Independent reference prototype · Demo-funded allowance',17,MUTED)
    text(d,(1125,666),f'{index} / 6',17,MUTED)
    d.rectangle((60,708,60+int(1160*index/6),713), fill=ORANGE)
    return image,d

frames=[]
im,d=base(1,'The idea','Good research. A human behind it.','Verify once, unlock an allowance, and see a real service payment.')
for x,n,title,body in [(60,'01','World ID','Selfie Check or stronger'),(455,'02','Parallel','A cited web answer'),(850,'03','Tempo + MPP','A payment and receipt')]:
    card(d,(x,336,x+370,535));text(d,(x+25,362),n,19,ORANGE);text(d,(x+25,414),title,31);text(d,(x+25,472),body,20,MUTED)
text(d,(60,579),'10 sponsored answers per account, while the shared demo budget lasts.',25)
frames.append(im)

im,d=base(2,'Connect','Start with World ID.','Open the public demo and choose “Verify to unlock research.”')
card(d,(60,328,780,603))
text(d,(92,360),'1. Open the approval link.',28)
text(d,(92,423),'2. Compare the code with the demo.',28)
text(d,(92,486),'3. Approve, then return to your question.',28)
text(d,(834,358),'SELFIE CHECK',17,ORANGE,bold=True)
text(d,(834,399),'No Orb visit\nrequired.',35)
text(d,(834,512),'Stronger Orb accounts\nalso qualify.',23,MUTED)
frames.append(im)

im,d=base(3,'Research','Ask something useful.','Example from the completed local end-to-end test.')
card(d,(60,321,1220,603))
text(d,(90,349),'QUESTION',16,ORANGE,bold=True)
text(d,(90,383),'What does Parallel.ai do? Cite its official website.',29)
d.line((90,438,1190,438),fill=LINE,width=2)
text(d,(90,465),'Parallel provides web search and research APIs for AI agents.',28)
text(d,(90,516),'Answer paraphrased from the recorded result · Source: https://parallel.ai/',21,GREEN)
text(d,(90,557),'Live web research uses Parallel’s production Responses endpoint.',19,MUTED)
frames.append(im)

im,d=base(4,'Payment','Inspect what actually settled.','Recorded local transaction · November 17, 2026')
card(d,(60,324,640,609));text(d,(90,352),'MPP PAYMENT CONFIRMED',17,GREEN,bold=True)
for y,name,value in [(402,'Service charge','$0.01'),(457,'Total wallet change','$0.010198'),(512,'Network / asset','Tempo / USDC.e')]:
    text(d,(90,y),name,22,MUTED);text(d,(385,y),value,25)
text(d,(700,356),'The demo pays.',37)
text(d,(700,417),'No user wallet, provider API key,\nor billing setup is needed for\nsponsored questions.',24,MUTED)
text(d,(700,536),'Transaction reference',16,ORANGE,bold=True)
text(d,(700,569),'0x1e0efee8…5cc2953',26)
frames.append(im)

im,d=base(5,'Shared allowance','One account. One allowance.','Separate browser and agent approvals resolve to the same account counter.')
for x,title,body in [(60,'Browser','Verify your World ID'),(660,'Agent / MCP','Verify the same account')]:
    card(d,(x,333,x+560,489));text(d,(x+28,363),title,30);text(d,(x+28,423),body,23,MUTED)
text(d,(60,535),'Recorded result: 10 → 9 answers remaining.',32,GREEN)
text(d,(60,591),'Replaying that request returned its saved answer and receipt with no new payment.',23,MUTED)
frames.append(im)

im,d=base(6,'Try it','Open the demo. Or bring your agent.','Browser and stdio MCP paths use the same hosted backend.')
card(d,(60,329,1220,603))
text(d,(90,359),'PUBLIC DEMO',16,ORANGE,bold=True)
text(d,(90,396),'parallel-research-pass.foundry-world.workers.dev',29)
text(d,(90,457),'CODE + MCP CONFIGURATION',16,ORANGE,bold=True)
text(d,(90,495),'github.com/lcusack/parallel-research-pass',29)
text(d,(90,552),'No invitation · $1 shared sponsorship budget · Caller-paid continuation available',21,MUTED)
frames.append(im)

with tempfile.TemporaryDirectory(prefix='research-pass-video-') as tmp:
    folder=Path(tmp)
    for i,frame in enumerate(frames): frame.save(folder/f'{i}.png')
    entries=''.join(f"file '{i}.png'\nduration 15\n" for i in range(len(frames)))+"file '5.png'\n"
    manifest=folder/'frames.txt';manifest.write_text(entries)
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-y','-loglevel','error','-f','concat','-safe','0','-i',str(manifest),'-vf','fps=24','-t','90','-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',str(OUT)],check=True)
    frames[0].save(ROOT/'hosted/public/walkthrough-poster.jpg',quality=90)
    sheet=Image.new('RGB',(1280,1080),PAPER)
    for i,frame in enumerate(frames): sheet.paste(frame.resize((640,360)),((i%2)*640,(i//2)*360))
    sheet.save(ROOT/'sharing/walkthrough-contact-sheet.png')
print(f'Created {OUT.name}: 90 seconds, {OUT.stat().st_size:,} bytes')
