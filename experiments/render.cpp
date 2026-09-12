// Feasibility kernel only: offline PCM, not a graph engine or a device callback.
extern "C" double sin(double);
extern "C" double cos(double);
static float output[96000];
extern "C" float* render(int kind, int rate, double pan) {
  const double pi=3.14159265358979323846;
  const int impulses[]={0,127,128,129,511,1023,1024,8000,16000,24000,32000,40000};
  double w=2*pi*1200/rate, alpha=sin(w)/2; // lowpass Q=1 = Web Audio lowpass Q of 0 dB
  double a0=1+alpha,b0=(1-cos(w))/2/a0,b1=(1-cos(w))/a0,b2=b0,a1=-2*cos(w)/a0,a2=(1-alpha)/a0;
  double x1=0,x2=0,y1=0,y2=0;
  for(int i=0;i<rate;i++) {
    float x=static_cast<float>(sin(2*pi*432*i/rate));
    if(kind==0) { x=0; for(int f:impulses) if(i==f) x=1; }
    x*=kind==0 ? 0.25+0.25*(i<1024?i/1024.0:1) : 0.25;
    double y=x;
    if(kind==1) { y=b0*x+b1*x1+b2*x2-a1*y1-a2*y2; x2=x1;x1=x;y2=y1;y1=y; }
    double left=1,right=1;
    if(kind==2) { left=cos((pan+1)*pi/4);right=sin((pan+1)*pi/4); }
    output[i]=static_cast<float>(y*left);output[rate+i]=static_cast<float>(y*right);
  }
  return output;
}
#ifndef __wasm__
#include <cstdio>
#include <cstdlib>
int main(int argc,char** argv) { if(argc!=4)return 1;int kind=atoi(argv[1]),rate=atoi(argv[2]);if(rate!=44100&&rate!=48000)return 2;fwrite(render(kind,rate,atof(argv[3])),sizeof(float),rate*2,stdout); }
#endif
